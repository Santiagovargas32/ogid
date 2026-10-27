import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {migrate} from '../storage/migrate.js';
import {SqlNewsArchive} from '../storage/sqlNewsArchive.js';
import {SituationStore} from '../storage/situations.js';
import {AgentRepository} from '../storage/agentRepository.js';
import {AWARENESS_SOURCES} from '../services/awareness/awarenessCatalog.js';
import {StorageManager} from '../storage/StorageManager.js';
const at=Date.parse('2026-10-27T11:00:00Z');
function fixture(){const dir=mkdtempSync(join(tmpdir(),'ogid-situations-')),file=join(dir,'fixture.sqlite'),db=new Database(file);db.pragma('foreign_keys=ON');db.pragma('journal_mode=WAL');migrate(db);const archive=new SqlNewsArchive(db,{analysisOnly:true}),store=new SituationStore(db,{now:()=>at}),repo=new AgentRepository({db},{now:()=>at});return{db,file,archive,store,repo,close(){archive.close();db.close();rmSync(dir,{recursive:true,force:true});}};}
function article(id,extra={}){return{id,revision:1,contentRevision:1,title:'Missile strike in Kyiv',url:`https://reuters.com/${id}`,publishedAt:new Date(at-1000).toISOString(),receivedAt:new Date(at-500).toISOString(),archiveLastSeenAt:new Date(at).toISOString(),usagePolicy:'headline-only-link-out',classification:{language:'en'},...extra};}
function drain(store,options={}){let state;for(let n=0;n<2000;n++){state=store.processPage({budgetMs:100,...options});if(!state.hasMore)return state;}assert.fail('CONSUMER_DID_NOT_DRAIN');}
function official(f,id,revision=1,extra={}){const source=AWARENESS_SOURCES.find(s=>s.admissionState==='active').sourceId;f.db.prepare('INSERT OR IGNORE INTO sources VALUES(?,?,?,?)').run(source,source,'active','{}');const v={eventId:id,revision,source:{sourceId:source},title:'Official maritime claim',kind:'maritime_alert',status:'released',publishedAt:new Date(at-1000).toISOString(),observedAt:new Date(at).toISOString(),importance:'high',...extra};f.db.prepare('INSERT INTO awareness_events VALUES(?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET revision=excluded.revision,payload_json=excluded.payload_json').run(id,source,v.observedAt,revision,JSON.stringify(v));return v;}

test('news burst above 500 is consumed through durable pages and a lost ACK replays without duplication',()=>{
 const f=fixture();try{
  f.db.transaction(()=>{for(let n=0;n<613;n++)f.archive.save(article(`burst-${String(n).padStart(4,'0')}`));}).immediate();
  const first=f.store.processPage({limit:17,budgetMs:100,requestId:'lost-ack'});assert.ok(first.hasMore);const count=f.db.prepare('SELECT count(*) n FROM situation_outbox').get().n;
  assert.deepEqual(f.store.processPage({limit:17,budgetMs:100,requestId:'lost-ack'}),first);assert.equal(f.db.prepare('SELECT count(*) n FROM situation_outbox').get().n,count);
  assert.throws(()=>f.store.processPage({limit:18,budgetMs:100,requestId:'lost-ack'}),{code:'SITUATION_REQUEST_CONFLICT'});
  const last=drain(new SituationStore(f.db,{now:()=>at}),{limit:23});assert.equal(last.streams.find(s=>s.stream==='news').processedEntries,613);
  assert.equal(f.db.prepare('SELECT count(*) n FROM situation_evidence').get().n,613);assert.equal(f.db.prepare('SELECT count(*) n FROM situation_outbox').get().n,613);
  assert.equal(f.db.prepare("SELECT count(*) n FROM situation_entities WHERE kind='incident'").get().n,0);
  const page=f.store.list();assert.ok(page.items.length);assert.equal(page.items[0].independentCorroboration,'not-established');assert.equal(page.items[0].occurredAt,null);assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
 }finally{f.close();}
});
test('Awareness burst above 500 retains immutable source revisions and processes later corrections',()=>{
 const f=fixture();try{
  f.db.transaction(()=>{for(let n=0;n<527;n++)official(f,`official-${n}`);}).immediate();f.store.processPage({limit:11,budgetMs:100});drain(new SituationStore(f.db,{now:()=>at}),{limit:31});
  assert.equal(f.store.status().streams.find(s=>s.stream==='awareness').processedEntries,527);official(f,'official-0',2,{status:'cancelled',title:'Official correction'});drain(f.store);
  const rows=f.db.prepare('SELECT revision,payload_json FROM awareness_revisions WHERE event_id=? ORDER BY revision').all('official-0');assert.equal(rows.length,2);assert.equal(JSON.parse(rows[0].payload_json).status,'released');assert.equal(f.db.prepare('SELECT count(*) n FROM geopolitical_alerts').get().n,527);
  const latest=JSON.parse(f.db.prepare('SELECT payload_json FROM geopolitical_alerts WHERE alert_id=?').get('official-0').payload_json);assert.equal(latest.verification,'corrected');assert.equal(latest.occurredAt,null);
  assert.throws(()=>official(f,'official-0',2,{title:'Changed without revision'}),/AWARENESS_REVISION_NOT_MONOTONIC/);
 }finally{f.close();}
});
test('outbox failure rolls back effects and cursor and leaves a visible retriable error',()=>{
 const f=fixture();try{
  f.archive.save(article('one'));f.db.exec("CREATE TRIGGER fail_situation_outbox BEFORE INSERT ON situation_outbox BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  assert.throws(()=>f.store.processPage({requestId:'atomic-retry'}));assert.equal(f.db.prepare('SELECT count(*) n FROM situation_revisions').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM geopolitical_alerts').get().n,0);assert.equal(f.store.status().streams.find(s=>s.stream==='news').lastSequence,0);assert.equal(f.store.status().state,'blocked');
  f.db.exec('DROP TRIGGER fail_situation_outbox');drain(f.store);assert.equal(f.db.prepare('SELECT count(*) n FROM situation_outbox').get().n,1);assert.equal(f.store.status().errorCode,null);
 }finally{f.close();}
});
test('historical indexing and metadata replays never produce new incident alerts',()=>{
 const f=fixture();try{
  const raw=article('old',{publishedAt:'2026-09-01T10:00:00Z',receivedAt:'2026-09-01T10:01:00Z'});f.archive.save(raw);f.db.prepare("UPDATE situation_consumers SET bootstrap_upper=(SELECT max(sequence) FROM news_comparison_changes) WHERE stream='news'").run();drain(f.store);
  assert.equal(f.db.prepare('SELECT count(*) n FROM geopolitical_alerts').get().n,0);assert.equal(f.store.changes().items[0].historical,true);
  f.archive.save({...raw,revision:2,metadataUpdatedAt:new Date(at).toISOString(),publisherId:'reuters'});drain(f.store);assert.equal(f.db.prepare('SELECT count(*) n FROM geopolitical_alerts').get().n,0);assert.equal(f.archive.getRecord('old').publishedAt,raw.publishedAt);
 }finally{f.close();}
});
test('explicit incidents retain identity and exact evidence while corrections invalidate current views only',()=>{
 const f=fixture();try{
  f.archive.save(article('evidence'));drain(f.store);const situation=f.store.list().items[0];
  const input={requestId:'incident-create',action:'create-incident',entityId:situation.id,title:'Reported incident under review',reviewer:'Fixture reviewer',reason:'Explicit association of source claim',references:['https://example.org/review'],sourceRefs:[{stream:'news',sourceId:'evidence',sourceRevision:1}]};
  const incident=f.store.review(input);assert.deepEqual(f.store.review(input),incident);const cut=f.store.upper();assert.equal(f.store.detail({id:incident.id}).entity.currentness.current,true);
  f.archive.save(article('evidence',{revision:2,title:'No missile strike in Kyiv',contentRevision:2}));drain(f.store);
  const current=f.store.detail({id:incident.id});assert.equal(current.entity.verification,'needs-review');assert.equal(current.entity.id,incident.id);assert.equal(current.items[0].sourceRevision,1);assert.equal(current.items[0].currentAtCut,false);
  const previous=f.store.detail({id:incident.id,atSequence:cut});assert.equal(previous.entity.currentness.current,true);assert.equal(previous.items[0].currentAtCut,true);assert.equal(f.store.list().items[0].modality,'negated');assert.equal(f.store.list().items[0].occurredAt,null);
 }finally{f.close();}
});
test('legacy inbox pagination and explicit read ACK survive a correction and lost ACK retry',()=>{
 const f=fixture();try{
  official(f,'a');official(f,'b');drain(f.store);const device=f.repo.deviceCreate({label:'fixture'}),first=f.repo.alerts({deviceId:device.deviceId,state:'all',limit:1});assert.equal(first.hasMore,true);
  const read=f.repo.alertState({deviceId:device.deviceId,alertId:'a',read:true,archived:false,revision:1,requestId:'lost-state-ack'});official(f,'a',2,{title:'Corrected a'});drain(f.store);
  assert.deepEqual(f.repo.alertState({deviceId:device.deviceId,alertId:'a',read:true,archived:false,revision:1,requestId:'lost-state-ack'}),read);
  const second=f.repo.alerts({deviceId:device.deviceId,state:'all',limit:1,cursor:first.nextCursor});assert.equal(second.asOfSequence,first.asOfSequence);assert.equal(new Set([...first.items,...second.items].map(x=>x.alertId)).size,2);assert.ok([...first.items,...second.items].every(x=>x.sourceRevision===1));
  const current=f.repo.alerts({deviceId:device.deviceId,state:'all'}).items.find(x=>x.alertId==='a');assert.equal(current.read,false);assert.equal(current.sourceRevision,2);
 }finally{f.close();}
});
test('an oversized source is blocked visibly and its cursor is not advanced',()=>{
 const f=fixture();try{official(f,'large',1,{summary:'x'.repeat(140000)});assert.throws(()=>f.store.processPage(),{code:'SITUATION_SOURCE_TOO_LARGE'});const status=f.store.status();assert.equal(status.state,'blocked');assert.equal(status.streams.find(s=>s.stream==='awareness').lastSequence,0);}finally{f.close();}
});
test('merge/split reviews continue across pages without merging incident identities or losing origin attribution',()=>{
 const f=fixture();try{
  for(let n=0;n<75;n++){f.archive.save(article(`kyiv-${String(n).padStart(3,'0')}`));f.archive.save(article(`odesa-${String(n).padStart(3,'0')}`,{title:'Missile strike in Odesa'}));}drain(f.store);
  const groups=['kyiv-000','odesa-000'].map(articleId=>f.archive.comparisons({articleId}).items[0].groupId);
  const operator=(requestId,action,extra)=>({requestId,action,reviewer:'Fixture reviewer',reason:'Explicit source context review',references:['https://example.org/review'],...extra});
  const origin=f.archive.reviewComparison(operator('origin-before-merge','origin',{articleIds:['odesa-000'],originChainId:'documented-wire'}));drain(f.store);
  const member=f.db.prepare("SELECT entity_id FROM situation_members WHERE source_id='odesa-000'").get();
  const incident=f.store.review({requestId:'before-merge-incident',action:'create-incident',entityId:member.entity_id,title:'Reported source claim',reviewer:'Fixture reviewer',reason:'Explicit association',references:['https://example.org/review'],sourceRefs:[{stream:'news',sourceId:'odesa-000',sourceRevision:1}]});
  f.archive.reviewComparison(operator('merge-many','merge',{groupIds:groups}));
  const page=f.store.processPage({limit:7,budgetMs:100});assert.equal(page.hasMore,true);assert.ok(page.streams.find(s=>s.stream==='news').continuation);
  drain(new SituationStore(f.db,{now:()=>at}),{limit:7});
  const current=f.db.prepare("SELECT e.payload_json FROM situation_evidence e WHERE stream='news' AND source_id='odesa-000' ORDER BY domain_sequence DESC LIMIT 1").get();assert.equal(JSON.parse(current.payload_json).originReviewId,origin.reviewId);
  assert.equal(f.store.detail({id:incident.id}).entity.verification,'needs-review');assert.equal(f.db.prepare("SELECT count(*) n FROM situation_entities WHERE kind='incident'").get().n,1);
  f.archive.reviewComparison(operator('split-again','split',{groupId:groups[0],articleIds:['odesa-000','odesa-001']}));drain(f.store,{limit:1});
  assert.equal(f.db.prepare("SELECT count(*) n FROM situation_entities WHERE kind='incident'").get().n,1);assert.equal(f.store.status().hasMore,false);assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
 }finally{f.close();}
});
test('entity and outbox cursors preserve a frozen cut through concurrent corrections and new sources',()=>{
 const f=fixture();try{
  for(let n=0;n<12;n++)f.archive.save(article(`paged-${n}`,{publishedAt:new Date(at-n*7*3600000).toISOString()}));drain(f.store);
  let page=f.store.list({limit:1}),seen=[...page.items],upper=page.asOfSequence;
  let changes=f.store.changes({limit:3}),emissions=[...changes.items],outboxUpper=changes.asOfSequence;
  f.archive.save(article('paged-0',{revision:2,contentRevision:2,title:'No missile strike in Kyiv'}));f.archive.save(article('new-after-cut',{title:'Missile strike in Gaza'}));drain(f.store);
  while(page.hasMore){page=f.store.list({limit:1,cursor:page.nextCursor});assert.equal(page.asOfSequence,upper);seen.push(...page.items);}assert.equal(new Set(seen.map(x=>x.id)).size,12);assert.ok(seen.every(x=>x.revision===1));
  while(changes.hasMore){changes=f.store.changes({limit:3,cursor:changes.nextCursor});assert.equal(changes.asOfSequence,outboxUpper);emissions.push(...changes.items);}assert.equal(emissions.length,12);assert.equal(new Set(emissions.map(x=>x.sequence)).size,12);assert.ok(f.store.changes({sinceSequence:changes.nextSinceSequence}).items.length>=2);
 }finally{f.close();}
});
test('synthetic and unsupported inputs are excluded while negation/future remain attributed reports',()=>{
 const f=fixture();try{
  f.archive.save(article('synthetic',{synthetic:true}));f.archive.save(article('unsupported',{classification:{language:'ru'}}));f.archive.save(article('denied',{title:'No missile strike in Kyiv'}));f.archive.save(article('future',{title:'Missile strike in Kyiv may happen tomorrow'}));drain(f.store);
  assert.equal(f.db.prepare('SELECT count(*) n FROM situation_members').get().n,2);assert.equal(f.store.status().streams.find(s=>s.stream==='news').excludedEntries,2);
  const detail=f.store.detail({id:f.store.list().items[0].id});assert.deepEqual(new Set(detail.items.map(x=>x.modality)),new Set(['negated','prospective']));assert.ok(detail.items.every(x=>x.occurredAt===null));assert.equal(detail.entity.independentCorroboration,'not-established');
 }finally{f.close();}
});
test('source priority is preserved and an ineligible correction cannot replace previously eligible alert content',()=>{
 const f=fixture();try{
  f.archive.save(article('critical',{threatLevel:'critical'}));drain(f.store);
  const alert=()=>JSON.parse(f.db.prepare("SELECT payload_json FROM geopolitical_alerts WHERE alert_id='news:critical'").get().payload_json);
  assert.equal(alert().severity,'critical');assert.equal(f.store.list().items[0].severity,'critical');
  f.archive.save(article('critical',{revision:2,threatLevel:'critical',metadataUpdatedAt:new Date(at).toISOString()}));drain(f.store);
  assert.equal(alert().severity,'critical');assert.equal(alert().changeKind,'metadata-updated');
  f.archive.save(article('critical',{revision:3,contentRevision:2,synthetic:true,title:'Synthetic content must remain ineligible'}));drain(f.store);
  assert.equal(alert().title,'Missile strike in Kyiv');assert.equal(alert().verification,'needs-review');assert.equal(alert().qualityReason,'source-ineligible');assert.equal(alert().sourceRevision,3);
  assert.equal(f.store.list().items[0].verification,'needs-review');assert.equal(f.store.list().items[0].title,'Missile strike in Kyiv');
 }finally{f.close();}
});
test('byte-limited pages count excluded journal entries exactly once and normalize date offsets',()=>{
 const f=fixture();try{
  for(let n=0;n<160;n++)f.archive.save(article('excluded-'+n,{classification:{language:'ru'}}));
  drain(f.store);const news=f.store.status().streams.find(s=>s.stream==='news');assert.equal(news.processedEntries,160);assert.equal(news.excludedEntries,160);
  f.archive.save(article('date-offset'));drain(f.store);
  assert.equal(f.store.list({from:'2026-10-27T11:30:00+01:00',to:'2026-10-27T12:30:00+01:00'}).items.length,1);
 }finally{f.close();}
});
test('restarting the business writer and readers resumes persisted pages and replays a lost ACK',async()=>{
 const f=fixture();let manager;try{
  for(let n=0;n<613;n++)f.archive.save(article('restart-'+n));
  const options={enabled:true,businessEnabled:true,databasePath:f.file},args={limit:23,budgetMs:50,requestId:'restart-ack'};
  manager=new StorageManager(options);await manager.start();
  const first=await manager.request('agent.call',{method:'alertSync',args});assert.equal(first.hasMore,true);
  await manager.close();manager=new StorageManager(options);await manager.start();
  assert.deepEqual(await manager.request('agent.call',{method:'alertSync',args}),first);
  let result=first;for(let n=0;n<200&&result.hasMore;n++)result=await manager.request('agent.call',{method:'alertSync',args:{limit:23,budgetMs:50}});
  assert.equal(result.hasMore,false);assert.equal(result.streams.find(s=>s.stream==='news').processedEntries,613);assert.equal(manager.queryManager.getStatus().queryOnly,true);
  await manager.close();manager=null;
  assert.equal(f.db.prepare('SELECT count(*) n FROM situation_outbox').get().n,613);assert.equal(f.db.prepare('SELECT count(*) n FROM situation_evidence').get().n,613);assert.equal(f.db.prepare('SELECT count(*) n FROM storage_writer_owner').get().n,0);
 }finally{await manager?.close();f.close();}
});
