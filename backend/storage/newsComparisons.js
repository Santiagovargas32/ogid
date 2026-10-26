import {AppError} from '../utils/error.js';
import {validateValue,OPERATIONS_VERSION,OPERATIONS_HASH} from '../contracts/ogidOperations.js';
import {COMPARISON_REVIEW_SCHEMA} from '../services/news/comparisonSchema.js';
import {comparisonFacts,comparisonHash,comparisonHints,COMPARISON_METHOD} from '../services/news/comparisonFacts.js';
import {safeUrl} from '../utils/researchProjection.js';

const parse=row=>row?JSON.parse(row.payload_json):null;
const fail=(message,status=400,code='INVALID_COMPARISON')=>{throw new AppError(message,status,code);};
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const HOUR=3600000;
const wireBytes=data=>{
  const payload={ok:true,queriedAt:'2000-01-01T00:00:00.000Z',origin:'OGID',identity:{version:OPERATIONS_VERSION,hash:OPERATIONS_HASH,adapterVersion:'0.4.0',pid:Number.MAX_SAFE_INTEGER,startedAt:'2000-01-01T00:00:00.000Z',profile:'all'},data,warnings:[],truncated:false};
  return Buffer.byteLength(JSON.stringify({structuredContent:payload,content:[{type:'text',text:JSON.stringify(payload)}]}))+512;
};
function cursor(value,scope){
  if(!value)return null;
  try{const c=JSON.parse(Buffer.from(value,'base64url').toString());if(c.scope!==scope||!Number.isSafeInteger(c.upper)||c.upper<0||typeof c.last!=='string'||c.last.length>128)throw 0;return c;}catch{fail('Cursor inválido o filtros diferentes.',400,'INVALID_COMPARISON_CURSOR');}
}
function page(items,base,input,makeCursor){
  const limit=Math.max(1,Math.min(100,input.limit||20)),max=Math.max(4096,Math.min(262144,input.maxBytes||65536));
  if(wireBytes({...base,items:[],hasMore:false,nextCursor:null})>max)fail('Los metadatos exceden el presupuesto; solicita más bytes.',413,'COMPARISON_ROW_TOO_LARGE');
  const selected=[];
  for(const item of items){if(selected.length>=limit)break;const data={...base,items:[...selected,item],hasMore:true,nextCursor:makeCursor(item)};if(wireBytes(data)>max){if(!selected.length)fail('Una entrada excede el presupuesto; solicita más bytes.',413,'COMPARISON_ROW_TOO_LARGE');break;}selected.push(item);}
  const hasMore=selected.length<items.length;
  return {...base,items:selected,hasMore,nextCursor:hasMore?makeCursor(selected.at(-1)):null};
}

// All mutations run in the existing business writer. Reads also work on a
// readonly/query_only connection; pagination freezes the append-only sequence.
export class NewsComparisons{
  constructor(db,{now=Date.now}={}){this.db=db;this.now=now;}
  upper(){return this.db.prepare('SELECT coalesce(max(sequence),0) AS n FROM news_comparison_changes').get().n;}
  change(kind,id,payload){return Number(this.db.prepare('INSERT INTO news_comparison_changes(kind,entity_id,changed_at,payload_json) VALUES(?,?,?,?)').run(kind,id,new Date(this.now()).toISOString(),JSON.stringify(payload)).lastInsertRowid);}
  group(id,upper=this.upper()){
    return parse(this.db.prepare('SELECT payload_json FROM news_comparison_group_versions WHERE group_id=? AND change_sequence<=? ORDER BY change_sequence DESC LIMIT 1').get(id,upper));
  }
  version(id,seq,extra={}){
    const old=this.group(id,seq),rows=this.db.prepare('SELECT m.origin_override,p.publisher_id,p.origin_chain_id FROM news_comparison_members m JOIN news_comparison_publication_versions p USING(article_id,article_revision) WHERE m.group_id=? LIMIT 501').all(id);
    const publishers=new Set(),origins=new Set();let unknown=0;
    for(const row of rows){if(row.publisher_id)publishers.add(row.publisher_id);const origin=row.origin_override||row.origin_chain_id;if(origin)origins.add(origin);else unknown++;}
    const representative=parse(this.db.prepare('SELECT p.payload_json FROM news_comparison_members m JOIN news_comparison_publication_versions p USING(article_id,article_revision) WHERE m.group_id=? ORDER BY m.article_id LIMIT 1').get(id));
    const value={...old,...extra,...(representative?{title:representative.title}:{}),groupId:id,revision:seq,updatedAt:new Date(this.now()).toISOString(),summary:{publications:rows.length,publishers:publishers.size,knownOriginChains:origins.size,unknownOrigins:unknown,independentCorroboration:'not-established'},methodVersion:COMPARISON_METHOD,meaning:'related coverage candidate; not a verified incident'};
    this.db.prepare('INSERT INTO news_comparison_group_versions VALUES(?,?,?)').run(id,seq,JSON.stringify(value));return value;
  }
  assignment(member,seq){
    const args=[seq,member.article_id,member.article_revision,member.group_id,member.locked||0,member.origin_override||null,member.review_id||null];
    this.db.prepare('INSERT INTO news_comparison_assignments VALUES(?,?,?,?,?,?,?)').run(...args);
    this.db.prepare('INSERT INTO news_comparison_members VALUES(?,?,?,?,?,?,?) ON CONFLICT(article_id) DO UPDATE SET article_revision=excluded.article_revision,group_id=excluded.group_id,change_sequence=excluded.change_sequence,locked=excluded.locked,origin_override=excluded.origin_override,review_id=excluded.review_id').run(member.article_id,member.article_revision,member.group_id,seq,member.locked||0,member.origin_override||null,member.review_id||null);
  }
  index(article){
    const revision=article.revision||1;
    if(this.db.prepare('SELECT 1 FROM news_comparison_publications WHERE article_id=? AND article_revision=?').get(article.id,revision))return;
    const facts=comparisonFacts({...article,revision}),previous=this.db.prepare('SELECT * FROM news_comparison_members WHERE article_id=?').get(article.id);
    facts.effectiveAt=Number.isFinite(Date.parse(facts.effectiveAt))?new Date(facts.effectiveAt).toISOString():new Date(this.now()).toISOString();
    const seq=this.change('publication',article.id,{articleId:article.id,articleRevision:revision,previousRevision:previous?.article_revision||null,methodVersion:COMPARISON_METHOD});
    const {claims,...publication}=facts;
    this.db.prepare('INSERT INTO news_comparison_publication_versions VALUES(?,?,?,?,?,?)').run(article.id,revision,facts.publisherId,facts.originChainId,facts.effectiveAt,JSON.stringify(publication));
    for(const claim of claims)this.db.prepare('INSERT INTO news_comparison_claims VALUES(?,?,?,?,?,?,?)').run(claim.claimId,article.id,revision,claim.ordinal,claim.conceptKey,claim.modality,JSON.stringify(claim));
    let groupId=previous?.locked?previous.group_id:null,reason=facts.groupingStatus;
    if(!groupId&&facts.signature){
      const at=Date.parse(facts.effectiveAt),candidates=this.db.prepare('SELECT group_id FROM news_comparison_groups WHERE signature=? AND anchor_at>=? AND anchor_at<=? AND auto_admission=1 ORDER BY anchor_at,group_id LIMIT 65').all(facts.signature,new Date(at-6*HOUR).toISOString(),new Date(at+6*HOUR).toISOString());
      if(candidates.length<=64)groupId=candidates.find(row=>row.group_id===previous?.group_id||this.db.prepare('SELECT count(*) AS n FROM news_comparison_members WHERE group_id=?').get(row.group_id).n<500)?.group_id;
      else reason='candidate-limit; manual-review-required';
      if(!groupId&&candidates.length)reason='candidate-capacity-or-limit; manual-review-required';
    }
    if(!groupId){
      groupId=`coverage-${comparisonHash([article.id,revision]).slice(0,32)}`;
      this.db.prepare('INSERT INTO news_comparison_groups VALUES(?,?,?,?,?)').run(groupId,facts.signature||`singleton:${article.id}`,facts.effectiveAt,seq,facts.signature?1:0);
    }
    this.assignment({...previous,article_id:article.id,article_revision:revision,group_id:groupId},seq);
    this.db.prepare('UPDATE news_comparison_changes SET payload_json=? WHERE sequence=?').run(JSON.stringify({articleId:article.id,articleRevision:revision,previousRevision:previous?.article_revision||null,groupId,previousGroupId:previous?.group_id||null,methodVersion:COMPARISON_METHOD}),seq);
    this.db.prepare('INSERT INTO news_comparison_publications VALUES(?,?,?) ON CONFLICT(article_id) DO UPDATE SET article_revision=excluded.article_revision,change_sequence=excluded.change_sequence').run(article.id,revision,seq);
    for(const id of new Set([groupId,previous?.group_id].filter(Boolean))){const old=this.group(id,seq);this.version(id,seq,old?{}:{title:facts.title,anchorAt:facts.effectiveAt,eventType:facts.eventType,locations:facts.locations,temporalHints:facts.temporalHints,status:'candidate',groupingReason:reason});}
  }
  list(input={}){
    const scope=comparisonHash(['groups',input.articleId||null,input.from||null,input.to||null]);
    const c=cursor(input.cursor,scope),upper=c?.upper??this.upper();
    let from=input.from||new Date(this.now()-7*86400000).toISOString(),to=input.to||new Date(this.now()).toISOString();
    // Freeze default windows as well as revisions between pages.
    if(c){from=c.from;to=c.to;}
    if(!Number.isFinite(Date.parse(from))||!Number.isFinite(Date.parse(to))||Date.parse(from)>Date.parse(to)||Date.parse(to)-Date.parse(from)>31*86400000)fail('Ventana máxima: 31 días.');
    from=new Date(from).toISOString();to=new Date(to).toISOString();
    if(c&&!Number.isFinite(Date.parse(c.at)))fail('Cursor temporal inválido.',400,'INVALID_COMPARISON_CURSOR');
    let rows;
    if(input.articleId){const assignment=this.db.prepare('SELECT group_id FROM news_comparison_assignments WHERE article_id=? AND change_sequence<=? ORDER BY change_sequence DESC LIMIT 1').get(input.articleId,upper);rows=assignment?[{group_id:assignment.group_id}]:[];}
    else rows=this.db.prepare('SELECT group_id FROM news_comparison_groups WHERE anchor_at>=? AND anchor_at<=? AND (anchor_at,group_id)<(?,?) AND created_sequence<=? ORDER BY anchor_at DESC,group_id DESC LIMIT ?').all(from,to,c?.at||to,c?.last||'\uffff',upper,Math.min(100,input.limit||20)+1);
    const items=rows.map(row=>this.group(row.group_id,upper));
    return page(items,{available:true,asOfSequence:upper,window:{from,to},coverage:{historicalIndex:'incremental; absence is not absence of coverage'},methodVersion:COMPARISON_METHOD},input,item=>encode({scope,upper,last:item.groupId,at:item.anchorAt,from,to}));
  }
  detail(input){
    const scope=comparisonHash(['group',input.groupId]),c=cursor(input.cursor,scope),upper=c?.upper??this.upper(),group=this.group(input.groupId,upper);
    if(!group)fail('Comparación desconocida.',404,'COMPARISON_NOT_FOUND');
    const rows=this.db.prepare(`SELECT a.*,p.payload_json FROM news_comparison_assignments a JOIN news_comparison_publication_versions p USING(article_id,article_revision)
      WHERE a.group_id=? AND a.change_sequence<=? AND a.article_id>? AND NOT EXISTS(SELECT 1 FROM news_comparison_assignments newer WHERE newer.article_id=a.article_id AND newer.change_sequence>a.change_sequence AND newer.change_sequence<=?) ORDER BY a.article_id LIMIT ?`).all(input.groupId,upper,c?.last||'',upper,(input.limit||20)+1);
    const items=rows.map(row=>({...JSON.parse(row.payload_json),originChainId:row.origin_override||JSON.parse(row.payload_json).originChainId,originReviewId:row.origin_override?this.db.prepare("SELECT a.review_id FROM news_comparison_assignments a JOIN news_comparison_reviews r ON r.review_id=a.review_id WHERE a.article_id=? AND a.origin_override=? AND a.change_sequence<=? AND json_extract(r.payload_json,'$.action')='origin' ORDER BY a.change_sequence DESC LIMIT 1").get(row.article_id,row.origin_override,upper)?.review_id||null:null,assignmentLocked:Boolean(row.locked),claims:this.db.prepare('SELECT payload_json FROM news_comparison_claims WHERE article_id=? AND article_revision=? ORDER BY ordinal').all(row.article_id,row.article_revision).map(parse)}));
    // Relations are loaded with each claim, separately paginated. Hints describe
    // only the returned page and never claim to exhaust the group.
    const fallbackHints={items:[],partial:true,scope:'returned-publications-only; byte-budget'};
    const result=page(items,{available:true,asOfSequence:upper,group,relationHints:fallbackHints},input,item=>encode({scope,upper,last:item.articleId}));
    const hints=comparisonHints(result.items.flatMap(item=>item.claims));
    result.relationHints={...hints,scope:'returned-publications-only'};
    // Keep the same byte limit after adding optional hints.
    if(wireBytes(result)>(input.maxBytes||65536))result.relationHints=fallbackHints;
    return result;
  }
  claim(input){
    const scope=comparisonHash(['claim-links-v2',input.claimId]),c=cursor(input.cursor,scope),upper=c?.upper??this.upper();
    const claim=parse(this.db.prepare('SELECT payload_json FROM news_comparison_claims WHERE claim_id=?').get(input.claimId));
    if(!claim||!this.db.prepare('SELECT 1 FROM news_comparison_assignments WHERE article_id=? AND article_revision=? AND change_sequence<=? LIMIT 1').get(claim?.articleId,claim?.articleRevision,upper))fail('Afirmación desconocida en este corte.',404,'COMPARISON_NOT_FOUND');
    const assignment=this.db.prepare('SELECT article_revision FROM news_comparison_assignments WHERE article_id=? AND change_sequence<=? ORDER BY change_sequence DESC LIMIT 1').get(claim.articleId,upper);
    const current=id=>Boolean(this.db.prepare(`SELECT 1 FROM news_comparison_claims c JOIN news_comparison_assignments a USING(article_id,article_revision) WHERE c.claim_id=? AND a.change_sequence<=? AND NOT EXISTS(SELECT 1 FROM news_comparison_assignments newer WHERE newer.article_id=a.article_id AND newer.change_sequence>a.change_sequence AND newer.change_sequence<=?) LIMIT 1`).get(id,upper,upper));
    const after=c?Number(c.last):0,limit=Math.min(100,input.limit||20);
    if(!Number.isSafeInteger(after)||after<0)fail('Cursor de relaciones inválido.',400,'INVALID_COMPARISON_CURSOR');
    const refs=['left_claim_id','right_claim_id'].flatMap(column=>this.db.prepare(`SELECT link_id,change_sequence FROM news_comparison_claim_links WHERE ${column}=? AND change_sequence>? AND change_sequence<=? ORDER BY change_sequence LIMIT ?`).all(input.claimId,after,upper,limit+1)).sort((a,b)=>a.change_sequence-b.change_sequence).slice(0,limit+1);
    const rows=refs.map(ref=>{const link=parse(this.db.prepare('SELECT payload_json FROM news_comparison_claim_links WHERE link_id=?').get(ref.link_id));const leftCurrent=current(link.leftClaimId),rightCurrent=current(link.rightClaimId);return {...link,leftCurrent,rightCurrent,current:leftCurrent&&rightCurrent};});
    return page(rows,{available:true,asOfSequence:upper,claim,current:assignment?.article_revision===claim.articleRevision},input,item=>encode({scope,upper,last:String(item.sequence)}));
  }
  changes(input={}){
    const scope=comparisonHash(['changes',input.sinceSequence||0]),c=cursor(input.cursor,scope),upper=c?.upper??this.upper(),last=c?Number(c.last):input.sinceSequence||0;
    if(!Number.isSafeInteger(last)||last<0||last>upper)fail('Secuencia inválida.');
    const rows=this.db.prepare('SELECT * FROM news_comparison_changes WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT ?').all(last,upper,(input.limit||100)+1);
    const items=rows.map(row=>{
      const review=row.kind==='publication'?null:parse(this.db.prepare('SELECT payload_json FROM news_comparison_reviews WHERE review_id=?').get(row.entity_id));
      return {sequence:row.sequence,kind:row.kind,entityId:row.entity_id,changedAt:row.changed_at,...JSON.parse(row.payload_json),...(review?{review}: {})};
    });
    const result=page(items,{available:true,asOfSequence:upper,meaning:'revision log; not an incident emission or consumer ACK'},input,item=>encode({scope,upper,last:String(item.sequence)}));
    result.nextSinceSequence=result.items.at(-1)?.sequence??last;
    return result;
  }
  review(input){
    if(!validateValue(input,COMPARISON_REVIEW_SCHEMA))fail('Revisión inválida.');
    const fields={merge:['groupIds'],split:['groupId','articleIds'],origin:['articleIds','originChainId'],'claim-link':['leftClaimId','rightClaimId','relation']}[input.action];
    if(fields.some(key=>input[key]===undefined)||Object.keys(input).some(key=>!['requestId','action','reviewer','reason','references',...fields].includes(key)))fail('Campos incompatibles con la acción.');
    for(const ref of input.references){try{const u=new URL(ref);if(safeUrl(ref)!==u.href)throw 0;}catch{fail('Las referencias deben ser URLs HTTP/S sin credenciales, secretos ni fragmentos.');}}
    const inputHash=comparisonHash(input);
    return this.db.transaction(()=>{
      const prior=this.db.prepare('SELECT input_hash,result_json FROM news_comparison_reviews WHERE request_id=?').get(input.requestId);
      if(prior){if(prior.input_hash!==inputHash)fail('requestId reutilizado con otros datos.',409,'COMPARISON_REVIEW_CONFLICT');return JSON.parse(prior.result_json);}
      const reviewId=`review-${comparisonHash(input.requestId).slice(0,32)}`,seq=this.change(input.action,reviewId,{reviewId,action:input.action}),affected=new Set();
      let result={reviewId,sequence:seq,action:input.action};
      if(input.action==='claim-link'){
        if(input.leftClaimId===input.rightClaimId)fail('Se requieren dos afirmaciones distintas.');
        for(const id of [input.leftClaimId,input.rightClaimId])if(!this.db.prepare('SELECT 1 FROM news_comparison_claims WHERE claim_id=?').get(id))fail('Afirmación desconocida.',404,'COMPARISON_NOT_FOUND');
        const linkId=`link-${comparisonHash(input.requestId).slice(0,32)}`;
        const link={linkId,leftClaimId:input.leftClaimId,rightClaimId:input.rightClaimId,relation:input.relation,reviewId,reviewer:input.reviewer,reason:input.reason,references:input.references,sequence:seq,meaning:'attributed reviewer assessment; not independent verification'};
        this.db.prepare('INSERT INTO news_comparison_claim_links VALUES(?,?,?,?,?,?,?)').run(linkId,input.leftClaimId,input.rightClaimId,input.relation,seq,reviewId,JSON.stringify(link));result.linkId=linkId;
      }else{
        let members,target;
        if(input.action==='merge'){
          for(const id of input.groupIds){const g=this.group(id);if(!g||g.status==='superseded')fail('Grupo desconocido o sustituido.',409,'COMPARISON_REVIEW_CONFLICT');affected.add(id);}
          members=this.db.prepare(`SELECT * FROM news_comparison_members WHERE group_id IN (${input.groupIds.map(()=>'?').join(',')}) LIMIT 501`).all(...input.groupIds);target=input.groupIds[0];
          if(members.length>500)fail('Revisión superior a 500 publicaciones; dividir el trabajo.',413,'COMPARISON_REVIEW_TOO_LARGE');
        }else{
          members=input.articleIds.map(id=>{const row=this.db.prepare('SELECT * FROM news_comparison_members WHERE article_id=?').get(id);if(!row)fail('Publicación no indexada.',404,'COMPARISON_NOT_FOUND');return row;});
          if(input.action==='split'){
            if(members.some(row=>row.group_id!==input.groupId))fail('La selección no pertenece al grupo.',409,'COMPARISON_REVIEW_CONFLICT');
            target=`coverage-${comparisonHash(input.requestId).slice(0,32)}`;
            const source=this.db.prepare('SELECT * FROM news_comparison_groups WHERE group_id=?').get(input.groupId);
            this.db.prepare('INSERT INTO news_comparison_groups VALUES(?,?,?,?,0)').run(target,source.signature,source.anchor_at,seq);
          }
        }
        for(const row of members){affected.add(row.group_id);const updated={...row,group_id:target||row.group_id,locked:input.action==='origin'?row.locked:1,origin_override:input.action==='origin'?input.originChainId:row.origin_override,review_id:reviewId};this.assignment(updated,seq);affected.add(updated.group_id);}
        for(const id of affected){this.db.prepare('UPDATE news_comparison_groups SET auto_admission=0 WHERE group_id=?').run(id);const old=this.group(id);this.version(id,seq,{...(old?{}:{...this.group(input.groupId),groupId:id}),status:input.action==='merge'&&id!==target?'superseded':'reviewed',redirectGroupId:input.action==='merge'&&id!==target?target:null,lastReview:{reviewId,reviewer:input.reviewer,reason:input.reason,references:input.references}});}
        result={...result,groupId:target||null,affectedGroups:[...affected],publications:members.length};
      }
      this.db.prepare('INSERT INTO news_comparison_reviews VALUES(?,?,?,?,?,?)').run(input.requestId,reviewId,seq,inputHash,JSON.stringify(input),JSON.stringify(result));
      this.db.prepare('UPDATE news_comparison_changes SET payload_json=? WHERE sequence=?').run(JSON.stringify({...result,...(input.action==='claim-link'?{leftClaimId:input.leftClaimId,rightClaimId:input.rightClaimId}:{}),methodVersion:COMPARISON_METHOD}),seq);
      return result;
    }).immediate();
  }
}
