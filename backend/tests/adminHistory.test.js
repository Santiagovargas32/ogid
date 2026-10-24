import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {migrate} from '../storage/migrate.js';
import {AdminHistoryProjection} from '../storage/adminHistoryProjection.js';
import {storageOperationContract} from '../contracts/ogidOperations.js';
import {StorageManager} from '../storage/StorageManager.js';
import {historyStatus} from '../controllers/historyAdminController.js';
import {EventEmitter} from 'node:events';

function seed(db,n=3000){
  const event=db.prepare('INSERT INTO events VALUES(?,NULL,?,1,NULL,?,\'unknown\',?)'),canonical=db.prepare('INSERT INTO research_rows VALUES(\'events\',?,?)');
  db.transaction(()=>{for(let i=0;i<n;i++){
    const row={eventId:`event-${i}`,identityVersion:i%2?'source-publication-v2':'legacy',revision:1,evidence:[],padding:'x'.repeat(1024)};
    const encoded=JSON.stringify(row);event.run(row.eventId,row.identityVersion,'2026-10-23T12:00:00Z',encoded);canonical.run(row.eventId,encoded);
  }})();
  db.prepare('INSERT INTO runtime_meta VALUES(?,?)').run('projection.events.status',JSON.stringify('ready'));
}
test('administrative histories read bounded SQL pages, retain exact counts and detect stale cursors',()=>{
  const db=new Database(':memory:');migrate(db);seed(db);
  try{
    const projector=new AdminHistoryProjection(db),sql=[],prepare=db.prepare.bind(db);
    db.prepare=text=>{sql.push(text);return prepare(text);};
    const first=projector.get({legacyLimit:11});assert.equal(first.eventIdentity.verified,1500);assert.equal(first.eventIdentity.total,3000);
    assert.equal(first.eventIdentity.legacyRequiresReplay.length,11);assert.ok(first.pagination.legacy.hasMore);
    assert.ok(!sql.some(s=>s.includes('SELECT entity_id FROM research_rows')));
    assert.ok(sql.some(s=>s.includes('refs AS MATERIALIZED')&&s.includes('LIMIT ?')));
    const second=projector.get({legacyLimit:11,legacyCursor:first.pagination.legacy.nextCursor});
    assert.equal(second.eventIdentity.legacyRequiresReplay.length,11);
    assert.equal(new Set([...first.eventIdentity.legacyRequiresReplay,...second.eventIdentity.legacyRequiresReplay].map(e=>e.eventId)).size,22);
    const before=sql.length;assert.deepEqual(projector.get({legacyLimit:11}),first);
    assert.ok(!sql.slice(before).some(s=>s.includes('GROUP BY identity_version')));
    db.prepare("INSERT INTO runtime_meta VALUES('research.revision','1')").run();
    assert.throws(()=>projector.get({legacyLimit:11,legacyCursor:first.pagination.legacy.nextCursor}),{code:'HISTORY_REVISION_CHANGED'});
    db.pragma('query_only=ON');assert.equal(projector.get().eventIdentity.total,3000);
  }finally{db.close();}
});
test('projection disagreement remains unknown instead of a false zero',()=>{
  const db=new Database(':memory:');migrate(db);seed(db,2);
  try{db.prepare("DELETE FROM research_rows WHERE collection='events'").run();const r=new AdminHistoryProjection(db).get();assert.equal(r.eventIdentity.verified,null);assert.equal(r.eventIdentity.projectionStatus,'unknown');}finally{db.close();}
});
test('legacy pagination follows the covering identity index across versions without sorting the corpus',()=>{
  const db=new Database(':memory:');migrate(db);seed(db,30);
  try{
    for(const [id,version]of [['event-0','older-v0'],['event-2','future-v3']]){
      db.prepare('UPDATE events SET identity_version=? WHERE event_id=?').run(version,id);
      db.prepare("UPDATE research_rows SET payload_json=json_set(payload_json,'$.identityVersion',?) WHERE collection='events' AND entity_id=?").run(version,id);
    }
    let legacySql;const prepare=db.prepare.bind(db);db.prepare=sql=>{if(sql.includes('refs AS MATERIALIZED'))legacySql=sql;return prepare(sql);};
    const projection=new AdminHistoryProjection(db),ids=[];let cursor=null;
    do{const page=projection.get({legacyLimit:4,legacyCursor:cursor});ids.push(...page.eventIdentity.legacyRequiresReplay.map(row=>row.eventId));cursor=page.pagination.legacy.nextCursor;}while(cursor);
    assert.equal(ids.length,15);assert.equal(new Set(ids).size,15);
    const cte=legacySql.slice(0,legacySql.indexOf('SELECT e.rowid'));
    const plan=prepare('EXPLAIN QUERY PLAN '+cte+'SELECT * FROM refs').all('',0,5);
    assert.ok(plan.some(row=>row.detail.includes('events_by_identity')));
    assert.ok(!plan.some(row=>row.detail.includes('TEMP B-TREE')));
  }finally{db.close();}
});
test('operation effects and query routing share one descriptor; real mutations remain writes',()=>{
  for(const [service,method] of [['admin','history'],['admin','historyRevision'],['sources','status'],['sources','holdings'],['history','coverage'],['history','get'],['imports','datasets']]){
    const c=storageOperationContract('domain.call',{service,method});assert.equal(c.role,'queries');assert.equal(c.pureRead,true);assert.equal(c.workClass,'read');
  }
  for(const [service,method] of [['sources','run'],['history','run'],['forecasts','evaluate'],['technical','get']])assert.equal(storageOperationContract('domain.call',{service,method}).pureRead,false);
});
test('cancelling one coalesced consumer preserves the other and releases listeners',async()=>{
  const manager=new StorageManager({enabled:true});let resolve,calls=0;
  manager.request=()=>{calls++;return new Promise(r=>{resolve=r;});};
  const a=new AbortController(),b=new AbortController();
  const one=manager.coalescedRead('domain.call',{service:'admin',method:'history'},{signal:a.signal});
  const two=manager.coalescedRead('domain.call',{service:'admin',method:'history'},{signal:b.signal});
  a.abort();await assert.rejects(one,{name:'AbortError'});resolve({ok:true});assert.deepEqual(await two,{ok:true});assert.equal(calls,1);assert.equal(manager.sharedReads.size,0);
});
test('private history validators are page-specific and return 304 before materializing the projection',async()=>{
  let materialized=0;
  const locals={business:{call:async(_service,method)=>{if(method==='historyRevision')return 'revision';materialized++;return {revision:'revision'};}},officialSourceService:{status:async()=>({asOf:new Date().toISOString(),sources:[],warnings:[]})}};
  const response=()=>Object.assign(new EventEmitter(),{app:{locals},headers:{},set(k,v){this.headers[k]=v;return this;},removeHeader(k){delete this.headers[k];},status(code){this.statusCode=code;return this;},end(){this.writableEnded=true;return this;},json(value){this.value=value;return this;}});
  const a=response();await historyStatus({query:{},get:()=>null},a);assert.equal(materialized,1);assert.equal(a.headers['Cache-Control'],'private, no-cache');
  const cached=response();await historyStatus({query:{},get:()=>a.headers.ETag},cached);assert.equal(cached.statusCode,304);assert.equal(materialized,1);
  const next=response();await historyStatus({query:{legacyCursor:'different-page'},get:()=>a.headers.ETag},next);assert.notEqual(next.headers.ETag,a.headers.ETag);assert.equal(materialized,2);
});
