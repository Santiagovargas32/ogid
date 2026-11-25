import assert from 'node:assert/strict';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {createAppServer} from '../../server.js';
import {prepareSignalMeasurement} from '../../services/intel/signalCorrelator.js';
import {pressureError} from '../../storage/resourceAdmission.js';

const [dir,attempt,domain = "news"] = process.argv.slice(2);
let quoteRequests = 0;
const file = join(dir,'signals.sqlite');
const app = createAppServer({host:'127.0.0.1',port:0,disableBackgroundRefresh:true,
  storage:{enabled:true,businessEnabled:true,databasePath:file},news:{providers:[],rssFeeds:[]},
  awareness:{mode:'off'},ai:{mode:'off',provider:'none'},market:{enabled:domain==='market',historyDir:dir,
    ...(domain==='market'?{provider:'yahoo',initialTickers:['GD'],tickers:['GD'],historyPersist:false}:{}),
    dailyCandles:{enabled:false},intradayCandles:{enabled:false}},
  marketDataService:{fetchQuotes:async()=>{
    quoteRequests++;
    return [{symbol:'GD',price:101,timestamp:new Date().toISOString(),currency:'USD',exchange:'NYSE'}];
  }}
});
const request = app.storageManager.request.bind(app.storageManager);
let stopping = false;
let attempts = 0;
let stages = 0, entered, release;
const entering = new Promise(resolve => { entered = resolve; });
const blocked = new Promise(resolve => { release = resolve; });
app.storageManager.request = async (op,input,...rest) => {
  if (attempt.startsWith('close-') && op === 'continuation.signalStage') {
    throw Object.assign(Error('Fixture staging receipt unavailable'),{code:'STORAGE_OUTCOME_UNKNOWN'});
  }
  if (attempt === 'close-broken' && stopping && op === 'continuation.scope' && input.scope === 'signals:news') {
    throw Object.assign(Error('Fixture closed writer'),{code:'STORAGE_NOT_READY'});
  }
  if (op === 'continuation.signalStage' && attempt.startsWith('stage-') && ++stages === 1) {
    entered();
    await blocked;
    if (attempt === 'stage-pressure') throw pressureError({state:'degraded',reason:'fixture-before-stage'});
    await request(op,input,...rest);
    throw Object.assign(Error('Lost staged measurement ACK'),{code:'STORAGE_OUTCOME_UNKNOWN'});
  }
  if (op === 'continuation.signalApply') {
    attempts++;
    if (attempt === 'defer') throw pressureError({state:'degraded',reason:'fixture-signal-apply'});
    await request(op,input,...rest);
    throw Object.assign(Error('Fixture lost committed signal ACK'),{code:'STORAGE_OUTCOME_UNKNOWN'});
  }
  return request(op,input,...rest);
};

function counts() {
  const db = new Database(file,{readonly:true});
  try {
    return {
      staged:db.prepare('SELECT count(*) FROM runtime_snapshots WHERE kind=?').pluck().get('signal-pending:'+domain),
      applied:db.prepare("SELECT count(*) FROM pipeline_runs WHERE pipeline_id='signals' AND status='healthy'").pluck().get()
    };
  } finally {
    db.close();
  }
}

try {
  await app.start();
  if (attempt === 'fence') {
    const measurement = prepareSignalMeasurement({meta:{lastRefreshAt:new Date().toISOString()}},{items:[]});
    const input = {domain,jobId:'signal-fence-fixture',measurement};
    await request('continuation.signalStage',input);
    await assert.rejects(request('continuation.signalStage',{...input,jobId:'other-fence-fixture'}),{code:'CONTINUATION_SCOPE_BUSY'});
    const old = await request('continuation.claim',{jobId:input.jobId,owner:'old'});
    const db = new Database(file);
    try {
      db.prepare("UPDATE acquisition_jobs SET job_json=json_set(job_json,'$.leaseUntil',0) WHERE job_id=?").run(input.jobId);
    } finally { db.close(); }
    const current = await request('continuation.claim',{jobId:input.jobId,owner:'current'});
    assert.ok(current.fence>old.fence);
    await assert.rejects(request('continuation.signalApply',old),{code:'CONTINUATION_LEASE_LOST'});
    assert.deepEqual(counts(),{staged:1,applied:0});
    await request('continuation.signalApply',current);
    await request('continuation.signalApply',current);
    await assert.rejects(request('continuation.signalApply',old),{code:'CONTINUATION_LEASE_LOST'});
    assert.deepEqual(counts(),{staged:0,applied:1});
  } else if (attempt.startsWith('close-')) {
    await assert.rejects(app.orchestrator.runNewsCycle('fixture-close',{storageOnly:true}),{code:'STORAGE_OUTCOME_UNKNOWN'});
  } else if (attempt.startsWith('stage-')) {
    const hour = Math.floor(Date.now()/3600000)*3600000-3600000;
    const run = minute => app.orchestrator.refreshSecondaryIntel({meta:{lastRefreshAt:new Date(hour+minute*60000).toISOString()},
      market:{quotes:{GD:{changePct:minute===10?2:0}}}},{items:[]},domain,[]);
    const first = run(10);
    await entering;
    const duplicate = run(10);
    await assert.rejects(run(25),{code:'CONTINUATION_SCOPE_BUSY'});
    release();
    const failure = {code:attempt==='stage-pressure'?'STORAGE_RESOURCE_PRESSURE':'STORAGE_OUTCOME_UNKNOWN'};
    await Promise.all([assert.rejects(first,failure),assert.rejects(duplicate,failure)]);
    assert.deepEqual(counts(),{staged:attempt==='stage-pressure'?0:1,applied:0});
    const second = await run(25);
    assert.equal(second.input.cutAt,new Date(hour+25*60000).toISOString());
    assert.deepEqual(counts(),{staged:0,applied:2});
    assert.equal((await run(25)).jobId,second.jobId);
    assert.deepEqual(counts(),{staged:0,applied:2});
  } else if (attempt === 'rollback') {
    const db = new Database(file);
    try {
      db.exec(`CREATE TRIGGER reject_signal_receipt BEFORE UPDATE ON acquisition_jobs
        WHEN json_extract(NEW.job_json,'$.scope')='signals:news' AND NEW.status='complete'
        BEGIN SELECT RAISE(ABORT,'signal receipt failure'); END`);
      await assert.rejects(app.orchestrator.runNewsCycle('fixture-news',{storageOnly:true}),{code:'SQLITE_CONSTRAINT_TRIGGER'});
      assert.deepEqual(counts(),{staged:1,applied:0});
      assert.equal(db.prepare("SELECT count(*) FROM runtime_snapshots WHERE kind='signals'").pluck().get(),0);
      assert.equal(db.prepare("SELECT count(*) FROM runtime_meta WHERE key GLOB 'signals.measurement.cut:*'").pluck().get(),0);
      db.exec('DROP TRIGGER reject_signal_receipt');
      await app.orchestrator.signalContinuation.recover(domain);
      assert.deepEqual(counts(),{staged:0,applied:1});
    } finally {
      db.close();
    }
  } else if (attempt === 'defer') {
    const cycle = domain === 'market'
      ? app.orchestrator.runMarketCycle('manual-market') : app.orchestrator.runNewsCycle('fixture-news',{storageOnly:true});
    await assert.rejects(cycle,{code:'STORAGE_RESOURCE_PRESSURE'});
    assert.deepEqual(counts(),{staged:1,applied:0});
  } else {
    assert.deepEqual(counts(),{staged:0,applied:1});
    await app.orchestrator.signalContinuation.recover(domain);
    assert.deepEqual(counts(),{staged:0,applied:1});
  }
  const expectedAttempts = attempt === 'fence' || attempt.startsWith('close-') ? 0 :
    attempt === 'rollback' || attempt.startsWith('stage-') ? 2 : 1;
  assert.equal(attempts,expectedAttempts);
  assert.equal(quoteRequests,domain === 'market' && attempt === 'defer' ? 1 : 0);
} finally {
  stopping = true;
  await app.stop();
}
const pending = app.app.locals.shutdownReport.deferredPersistence.cycleContinuations;
assert.equal(pending.some(row=>row.domain===domain && row.phase==='signal-measurement' && row.durable),attempt==='defer');

if (attempt.startsWith('close-')) {
  const row = pending.find(item=>item.domain===domain && item.verification===(attempt==='close-broken'?'unknown':'unconfirmed'));
  assert.ok(row);
  assert.equal(row.durable,false);
}
