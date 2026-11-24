import assert from 'node:assert/strict';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {createAppServer} from '../../server.js';
import {pressureError} from '../../storage/resourceAdmission.js';

const [dir,attempt] = process.argv.slice(2);
const file = join(dir,'research.sqlite');
const app = createAppServer({host:'127.0.0.1',port:0,disableBackgroundRefresh:true,
  storage:{enabled:true,businessEnabled:true,databasePath:file},news:{providers:[],rssFeeds:[]},
  awareness:{mode:'visible'},ai:{mode:'off',provider:'none'},market:{enabled:false,historyDir:dir,
    dailyCandles:{enabled:false},intradayCandles:{enabled:false}}});
const blocked = attempt !== 'recover';
const revision = blocked ? 1 : 2;
const ids = () => {
  const db = new Database(file,{readonly:true});
  try {
    return db.prepare("SELECT json_extract(payload_json,'$.sourceEventId') FROM events ORDER BY 1").pluck().all();
  } finally { db.close(); }
};
let cuts = 0, lost = 0;
const original = app.storageManager.request.bind(app.storageManager);
app.storageManager.request = async (op,input,...args) => {
  if (op === 'continuation.scope' && attempt === 'unknown' && app.orchestrator.stopping
      && input.scope === 'research:awareness-events') {
    throw Object.assign(Error('Fixture lost writer during shutdown'),{code:'STORAGE_WORKER_FAILED'});
  }
  const blockedOperation = attempt === 'admission' ? 'continuation.researchAwarenessAdmit' : 'continuation.researchAwarenessPage';
  if (op === blockedOperation && blocked) {
    cuts++;
    throw pressureError({state:'degraded',reason:'fixture-after-admission'});
  }
  const result = await original(op,input,...args);
  if (op === 'continuation.researchAwarenessPage' && !lost) {
    lost++;
    throw Object.assign(Error('Fixture lost ACK'),{code:'STORAGE_OUTCOME_UNKNOWN'});
  }
  return result;
};
try {
  await app.start();
  if (attempt === 'recover') {
    assert.deepEqual(ids(),['release-1']);
    assert.equal(lost,1);
  }
  app.app.locals.awarenessService.getSnapshot = () => ({mode:'visible',revision,recent:[{
    eventId:'release-'+revision,title:'Release '+revision,source:{sourceId:'fixture'},
    canonicalUrl:'https://fixture.invalid/'+revision,scheduledAt:'2026-11-24T12:00:00.000Z'
  }],upcoming:[]});
  const cycle = () => app.orchestrator.runNewsCycle('fixture-news',{storageOnly:true});
  if (blocked) {
    await assert.rejects(cycle(),{code:'STORAGE_RESOURCE_PRESSURE'});
    assert.equal(cuts,1);
    assert.deepEqual(ids(),[]);
    assert.equal(app.app.locals.researchPipeline.awarenessEvents.pendingReplay,true);
  } else {
    await cycle();
    assert.deepEqual(ids(),['release-1','release-2']);
    assert.equal(app.app.locals.researchPipeline.awarenessEvents.pendingReplay,false);
  }
} finally {
  await app.stop();
}
const pending = app.app.locals.shutdownReport.deferredPersistence.cycleContinuations.filter(row=>row.domain==='research');
if (attempt === 'defer') {
  assert.equal(pending.length,1);
  assert.equal(pending[0].durable,true);
  assert.equal(pending[0].cursor,0);
} else if (attempt === 'admission') {
  assert.equal(pending.length,1);
  assert.equal(pending[0].durable,false);
  assert.equal(pending[0].verification,'unconfirmed');
} else if (attempt === 'unknown') {
  assert.equal(pending.length,1);
  assert.equal(pending[0].durable,false);
  assert.equal(pending[0].verification,'unknown');
} else {
  assert.deepEqual(pending,[]);
}
