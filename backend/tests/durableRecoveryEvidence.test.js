import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {migrate} from '../storage/migrate.js';
import {recoverySnapshot,compareRecovery} from '../scripts/verify-durable-recovery.js';

function cohort(){
  const before={version:1,schema:30,owners:[],activeAgent:[],agentDigest:'agent',runsDigest:'runs',publicationsDigest:'publications',heads:{news:20,awareness:10},consumers:[{stream:'news',last_sequence:18,error_code:null},{stream:'awareness',last_sequence:9,error_code:null}],receipts:[{job_id:'job',request_id:'receipt',status:'complete',cursor:2,items:2}],projections:[{scope_key:'scope',state:'complete',required_revision:2,completed_revision:2,last_error:null}],rss:[{kind:'feed',updated_at:'2026-10-29',committed:100,attempted:100}],rssCycles:10,outboxMissing:0};
  const after=structuredClone(before);after.heads.news=21;after.consumers[0].last_sequence=20;after.consumers[1].last_sequence=10;after.rssCycles++;
  return {before,after};
}
test('recovery evidence accepts initial heads consumed with new durable work remaining',()=>{
  const {before,after}=cohort();assert.deepEqual(compareRecovery(before,after),{verified:true,failures:[],newsRemaining:1,awarenessRemaining:0,rssCycles:1});
});
test('recovery evidence rejects loss, uncertain projections, replay and agent activity',()=>{
  for(const mutate of [a=>a.consumers[0].last_sequence=19,a=>a.receipts=[],a=>a.receipts[0].request_id='replacement',a=>a.receipts[0].cursor=1,a=>a.projections=[],a=>a.projections[0].completed_revision=1,a=>a.rss=[],a=>a.rss[0].committed=99,a=>a.rssCycles=10,a=>a.agentDigest='new-fence',a=>a.runsDigest='new-run',a=>a.publicationsDigest='new-publication',a=>a.owners=[{}],a=>a.activeAgent=[{}],a=>a.outboxMissing=1]){
    const {before,after}=cohort();mutate(after);assert.equal(compareRecovery(before,after).verified,false);
  }
});
test('snapshot uses the real schema and refuses a writable connection',()=>{
  const db=new Database(':memory:');
  try{
    migrate(db);assert.throws(()=>recoverySnapshot(db),/query_only/);
    db.prepare('INSERT INTO acquisition_jobs VALUES(?,?,?,?,?,?,?)').run('job','receipt','market-persistence','complete','2026-10-29','2026-10-29',JSON.stringify({cursor:1,candles:[{}]}));
    db.prepare('INSERT INTO runtime_snapshots VALUES(?,?,?)').run('rss-canonical-feed:feed','2026-10-29',JSON.stringify({lastCommittedAt:123,lastAttemptAt:100,etag:'etag',contentHash:'content',articles:[{private:'not exported'}]}));
    db.pragma('query_only=ON');const result=recoverySnapshot(db);
    assert.equal(result.schema,30);assert.deepEqual(result.receipts,[{job_id:'job',request_id:'receipt',status:'complete',cursor:1,items:1}]);assert.equal(result.rss[0].committed,123);assert.equal(result.rss[0].etag,'etag');assert.equal(JSON.stringify(result).includes('not exported'),false);assert.equal(result.outboxMissing,0);
  }finally{db.close();}
});
