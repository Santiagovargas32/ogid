import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync,copyFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {migrate} from '../storage/migrate.js';
import {SqlNewsArchive} from '../storage/sqlNewsArchive.js';
import {NewsComparisons} from '../storage/newsComparisons.js';
import {comparisonFacts} from '../services/news/comparisonFacts.js';
import {projectOperation} from '../utils/researchProjection.js';
import {getOperation} from '../contracts/ogidOperations.js';
const at='2026-10-26T10:00:00.000Z';
const article=(id,extra={})=>({id,revision:1,title:'Missile strike in Kyiv',url:`https://example.org/${id}`,publishedAt:at,receivedAt:at,archiveLastSeenAt:at,usagePolicy:'standard-link-out',classification:{language:'en'},...extra});
const review=(requestId,action,extra)=>({requestId,action,reviewer:'Fixture reviewer',reason:'Explicit fixture editorial evidence',references:['https://example.org/evidence'],...extra});
function setup(){const dir=mkdtempSync(join(tmpdir(),'ogid-comparisons-')),file=join(dir,'fixture.sqlite'),db=new Database(file);db.pragma('foreign_keys=ON');migrate(db);const archive=new SqlNewsArchive(db,{now:()=>Date.parse(at)+3600000}),store=archive.comparisonStore;return {db,file,archive,store,close(){archive.close();db.close();rmSync(dir,{recursive:true,force:true});}};}
function groupOf(store,id){return store.list({articleId:id}).items[0];}

test('five syndicated publications retain one known origin without claiming independent corroboration',()=>{
  const f=setup();try{for(let n=0;n<5;n++)f.archive.save(article(`copy-${n}`,{publisherId:`publisher-${n}`,publisherResolution:{status:'resolved'},originChainId:'wire-explicit-123'}));
    const g=groupOf(f.store,'copy-0');assert.equal(g.summary.publications,5);assert.equal(g.summary.publishers,5);assert.equal(g.summary.knownOriginChains,1);assert.equal(g.summary.independentCorroboration,'not-established');
    f.archive.save(article('unknown'));assert.equal(groupOf(f.store,'unknown').summary.unknownOrigins,1);
    const projected=projectOperation(getOperation('news.comparison'),f.store.detail({groupId:g.groupId}));assert.equal(projected.items[0].claims[0].evidence.articleRevision,1);assert.equal(projected.items[0].originChainId,'wire-explicit-123');
  }finally{f.close();}
});
test('different headlines in five languages relate; different days, places and explicit historical dates stay separate',()=>{
  const f=setup();try{
    const titles=[['en','Missile strike in Kyiv'],['es','Ataque con misiles en Kiev'],['fr','Frappe de missiles à Kiev'],['de','Raketenangriff in Kiew'],['pt','Ataque com mísseis em Kiev']];
    titles.forEach(([language,title],n)=>f.archive.save(article(`lang-${n}`,{title,classification:{language}})));
    assert.equal(groupOf(f.store,'lang-0').summary.publications,5);
    for(const [id,extra] of [['next-day',{publishedAt:'2026-10-27T10:00:00Z'}],['historical',{title:'Missile strike in Kyiv in 2014'}],['other-place',{title:'Missile strike in Gaza'}]]){f.archive.save(article(id,extra));assert.notEqual(groupOf(f.store,id).groupId,groupOf(f.store,'lang-0').groupId);}
  }finally{f.close();}
});
test('negation, future and opinion remain attributed modalities; restricted and unsupported text is explicit',()=>{
  for(const [title,expected] of [['No missile strike in Kyiv','negated'],['Missile strike in Kyiv may happen tomorrow','prospective'],['Opinion: missile strike in Kyiv','opinion']])assert.equal(comparisonFacts(article('x',{title})).claims[0].modality,expected);
  const restricted=comparisonFacts(article('x',{usagePolicy:'headline-only-link-out',excerpt:'PRIVATE TEXT: Missile strike in Kyiv',title:'Regional news'}));assert.equal(restricted.claims.length,1);assert.ok(!JSON.stringify(restricted).includes('PRIVATE'));
  for(const extra of [{usagePolicy:{mode:'headline-only-link-out'}},{usagePolicy:{contentPolicy:'headline-only-link-out'}},{provenance:{contentPolicy:'headline-only-link-out'}}]){
    const facts=comparisonFacts(article('restricted',{...extra,excerpt:'PRIVATE TEXT: Missile strike in Kyiv',title:'Regional news'}));assert.equal(facts.claims.length,1);assert.ok(!JSON.stringify(facts).includes('PRIVATE'));assert.equal(facts.textScope,'headline');
  }
  const unsupported=comparisonFacts(article('x',{classification:{language:'ru'}}));assert.equal(unsupported.groupingStatus,'insufficient-context');assert.equal(unsupported.classificationStatus,'unsupported-language');
  assert.equal(comparisonFacts(article('x',{publishedAt:null})).signature,null);
  assert.equal(comparisonFacts(article('x',{title:'Missile strike from Kyiv to Gaza'})).signature,null);
  assert.equal(comparisonFacts(article('x',{title:'Workers strike in Kyiv'})).eventType,'labor-strike');
});
test('frozen member pages survive corrections and audited split; replay is idempotent and preserves article originals',()=>{
  const f=setup();try{
    for(const id of ['a','b','c'])f.archive.save(article(id));
    const original=f.db.prepare('SELECT * FROM article_revisions ORDER BY article_id').all(),g=groupOf(f.store,'a');
    const first=f.store.detail({groupId:g.groupId,limit:1});
    const input=review('split-1','split',{groupId:g.groupId,articleIds:['b']});const split=f.store.review(input);assert.deepEqual(f.store.review(input),split);
    assert.throws(()=>f.store.review({...input,reason:'Different request payload'}),{code:'COMPARISON_REVIEW_CONFLICT'});
    f.archive.save(article('b',{revision:2,title:'No missile strike in Kyiv'}));
    assert.equal(groupOf(f.store,'b').groupId,split.groupId);
    assert.equal(groupOf(f.store,'b').title,'No missile strike in Kyiv');
    let next=first.nextCursor,seen=[...first.items];while(next){const p=f.store.detail({groupId:g.groupId,limit:1,cursor:next});seen.push(...p.items);next=p.nextCursor;}
    assert.deepEqual(seen.map(x=>[x.articleId,x.articleRevision]),[['a',1],['b',1],['c',1]]);
    assert.equal(f.store.detail({groupId:g.groupId}).items.length,2);
    const merged=f.store.review(review('merge-1','merge',{groupIds:[g.groupId,split.groupId]}));assert.equal(merged.publications,3);assert.equal(f.store.group(split.groupId).redirectGroupId,g.groupId);
    const audit=f.store.changes().items.find(row=>row.reviewId===split.reviewId);assert.equal(audit.review.reason,input.reason);assert.deepEqual(audit.review.articleIds,['b']);
    for(const row of original)assert.deepEqual(f.db.prepare('SELECT * FROM article_revisions WHERE article_id=? AND revision=?').get(row.article_id,row.revision),row);
    assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
  }finally{f.close();}
});
test('origin review and claim support/contradiction links retain evidence and obsolete revision visibility',()=>{
  const f=setup();try{
    f.archive.save(article('a'));f.archive.save(article('b',{title:'No missile strike in Kyiv'}));const g=groupOf(f.store,'a'),detail=f.store.detail({groupId:g.groupId});
    assert.equal(detail.relationHints.items[0].relation,'possible-contradiction');
    const [left,right]=detail.items.map(x=>x.claims[0].claimId);
    f.store.review(review('origins','origin',{articleIds:['a','b'],originChainId:'documented-wire'}));assert.equal(groupOf(f.store,'a').summary.knownOriginChains,1);assert.equal(groupOf(f.store,'a').summary.unknownOrigins,0);
    assert.equal(f.archive.getRecord('a').originChainId,undefined);
    f.store.review(review('contradiction','claim-link',{leftClaimId:left,rightClaimId:right,relation:'contradiction'}));
    assert.equal(f.store.claim({claimId:left}).items[0].references[0],'https://example.org/evidence');
    f.archive.save(article('a',{revision:2,title:'Missile strike in Kyiv confirmed by publication'}));
    assert.equal(f.store.claim({claimId:left}).current,false);assert.equal(f.store.claim({claimId:left}).items[0].relation,'contradiction');assert.equal(f.store.claim({claimId:right}).items[0].current,false);
    assert.throws(()=>f.store.review({...review('private-url','origin',{articleIds:['a'],originChainId:'x'}),references:['https://example.org/?token=private']}),{code:'INVALID_COMPARISON'});
    const count=f.store.upper();assert.throws(()=>f.store.review(review('bad','claim-link',{leftClaimId:left,rightClaimId:'unknown',relation:'support'})),{code:'COMPARISON_NOT_FOUND'});assert.equal(f.store.upper(),count);
    assert.throws(()=>f.store.review({...review('bad2','origin',{articleIds:['a'],originChainId:'x'}),unexpected:true}),{code:'INVALID_COMPARISON'});
  }finally{f.close();}
});
test('ordered change cursor survives over 500 writes, concurrent additions and reopen without skipping',()=>{
  const f=setup();try{
    for(let n=0;n<513;n++)f.archive.save(article(`item-${String(n).padStart(4,'0')}`,{title:'Regional news'}));
    const first=f.store.changes({limit:37,maxBytes:16384});assert.equal(first.nextSinceSequence,first.items.at(-1).sequence);
    f.archive.save(article('later'));const reader=new Database(f.file,{readonly:true});reader.pragma('query_only=ON');
    try{const store=new NewsComparisons(reader);let c=first.nextCursor,items=[...first.items];while(c){const p=store.changes({limit:37,maxBytes:16384,cursor:c});items.push(...p.items);c=p.nextCursor;}
      assert.equal(items.length,513);assert.equal(new Set(items.map(x=>x.sequence)).size,513);assert.equal(store.changes({sinceSequence:513}).items[0].articleId,'later');assert.throws(()=>store.review(review('reader','origin',{articleIds:['later'],originChainId:'x'})));
    }finally{reader.close();}
    assert.throws(()=>f.store.changes({sinceSequence:1,cursor:first.nextCursor}),{code:'INVALID_COMPARISON_CURSOR'});
  }finally{f.close();}
});
test('metadata polling is idempotent and list byte budgets/cursor filters remain bounded',()=>{
  const f=setup();try{
    for(let n=0;n<12;n++)f.archive.save(article(`item-${n}`,{title:`Regional news ${n}`}));
    const seq=f.store.upper();f.archive.save(article('item-0'));assert.equal(f.store.upper(),seq);
    const first=f.store.list({limit:10,maxBytes:8192});assert.ok(first.hasMore);assert.ok(Buffer.byteLength(JSON.stringify(first))<8192);
    assert.throws(()=>f.store.list({articleId:'item-0',cursor:first.nextCursor}),{code:'INVALID_COMPARISON_CURSOR'});
  }finally{f.close();}
});
test('origin evidence remains attributable after split, merge and publication correction',()=>{
  const f=setup();try{
    for(const id of ['a','b'])f.archive.save(article(id));const group=groupOf(f.store,'a');
    const origin=f.store.review(review('origin-proof','origin',{articleIds:['a'],originChainId:'documented-origin'}));
    const split=f.store.review(review('split-origin','split',{groupId:group.groupId,articleIds:['a']}));
    assert.equal(f.store.detail({groupId:split.groupId}).items[0].originReviewId,origin.reviewId);
    f.store.review(review('merge-origin','merge',{groupIds:[group.groupId,split.groupId]}));
    f.archive.save(article('a',{revision:2,title:'No missile strike in Kyiv'}));
    const detail=f.store.detail({groupId:group.groupId});assert.equal(detail.items.find(x=>x.articleId==='a').originReviewId,origin.reviewId);
    assert.equal(detail.items.find(x=>x.articleId==='b').originReviewId,null);
  }finally{f.close();}
});
test('claim link pages keep a frozen sequence across both endpoints and use ordered indices',()=>{
  const f=setup();try{
    f.archive.save(article('a'));f.archive.save(article('b'));const ids=f.store.detail({groupId:groupOf(f.store,'a').groupId}).items.map(x=>x.claims[0].claimId);
    for(let n=0;n<23;n++)f.store.review(review(`link-${n}`,'claim-link',{leftClaimId:ids[n%2],rightClaimId:ids[1-n%2],relation:'context'}));
    const first=f.store.claim({claimId:ids[0],limit:3});f.store.review(review('after-cut','claim-link',{leftClaimId:ids[0],rightClaimId:ids[1],relation:'support'}));
    const seen=[...first.items];let next=first.nextCursor;while(next){const p=f.store.claim({claimId:ids[0],limit:3,cursor:next});seen.push(...p.items);next=p.nextCursor;}
    assert.equal(seen.length,23);assert.equal(new Set(seen.map(x=>x.linkId)).size,23);assert.ok(seen.every((x,n)=>!n||seen[n-1].sequence<x.sequence));
    for(const column of ['left_claim_id','right_claim_id']){const plan=f.db.prepare(`EXPLAIN QUERY PLAN SELECT link_id,change_sequence FROM news_comparison_claim_links WHERE ${column}=? AND change_sequence>? AND change_sequence<=? ORDER BY change_sequence LIMIT ?`).all(ids[0],0,9999,4).map(x=>x.detail).join(' ');assert.ok(!plan.includes('TEMP B-TREE'),plan);assert.ok(plan.includes('INDEX'),plan);}
  }finally{f.close();}
});
test('empty pages and long escaped claims enforce the declared byte budget',()=>{
  const f=setup();try{
    f.archive.save(article('a',{excerpt:'\\"'.repeat(500)}));const g=groupOf(f.store,'a'),claim=f.store.detail({groupId:g.groupId}).items[0].claims[1];
    assert.throws(()=>f.store.claim({claimId:claim.claimId,maxBytes:4096}),{code:'COMPARISON_ROW_TOO_LARGE'});
    assert.equal(f.store.claim({claimId:claim.claimId,maxBytes:16384}).claim.text,claim.text);
    f.store.review({...review('empty-split','split',{groupId:g.groupId,articleIds:['a']}),reason:'"'.repeat(1000),references:Array.from({length:5},(_,n)=>`https://example.org/${n}/`+'a'.repeat(460))});
    assert.equal(f.store.group(g.groupId).summary.publications,0);
    assert.throws(()=>f.store.detail({groupId:g.groupId,maxBytes:4096}),{code:'COMPARISON_ROW_TOO_LARGE'});
    assert.equal(f.store.detail({groupId:g.groupId,maxBytes:32768}).items.length,0);
  }finally{f.close();}
});
test('025 migrates 024 additively and historical comparison indexing preserves frozen publication revisions',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ogid-025-')),db=new Database(':memory:');
  try{const source=new URL('../storage/migrations/',import.meta.url);for(const name of readdirSync(source).filter(n=>Number(n.slice(0,3))<=24))copyFileSync(new URL(name,source),join(dir,name));migrate(db,dir);
    const before=db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();migrate(db);assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=24 ORDER BY version').all(),before);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
  const f=setup();try{f.archive.ingest([{title:'Missile strike in Kyiv',url:'https://reuters.com/fixture',publishedAt:at,provider:'rss'}]);
    const original=f.db.prepare('SELECT * FROM article_revisions').all();f.db.exec('DELETE FROM news_comparison_members; DELETE FROM news_comparison_assignments; DELETE FROM news_comparison_claims; DELETE FROM news_comparison_publications; DELETE FROM news_comparison_publication_versions; DELETE FROM news_comparison_group_versions; DELETE FROM news_comparison_groups; DELETE FROM news_comparison_changes');
    assert.equal(f.archive.enrichEditorialPage().complete,true);assert.equal(f.store.upper()>0,true);for(const row of original)assert.deepEqual(f.db.prepare('SELECT * FROM article_revisions WHERE article_id=? AND revision=?').get(row.article_id,row.revision),row);
  }finally{f.close();}
});
test('historical metadata adds multilingual country mentions while preserving attributed countries, identity and content dates',()=>{
  const f=setup();try{
    f.archive.save(article('legacy-es',{title:'Ataque con misiles en Ucrania y Kiev',classification:{language:'es'},countryMentions:['DE'],contentRevision:1,archiveChangedAt:at}));
    const before=f.archive.getRecord('legacy-es'),frozen=f.db.prepare("SELECT * FROM article_revisions WHERE article_id='legacy-es' AND revision=1").get();
    f.archive.enrichEditorialPage();const after=f.archive.getRecord('legacy-es');assert.deepEqual(after.countryMentions,['DE','UA']);
    for(const key of ['id','url','publishedAt','receivedAt','archiveChangedAt','contentRevision'])assert.deepEqual(after[key],before[key]);
    assert.deepEqual(f.db.prepare("SELECT * FROM article_revisions WHERE article_id='legacy-es' AND revision=1").get(),frozen);
    assert.deepEqual(f.store.detail({groupId:groupOf(f.store,'legacy-es').groupId}).items[0].entities,['DE','UA']);
  }finally{f.close();}
});
