// Each invocation is a fresh principal and storage worker on the same fixture DB.
import assert from 'node:assert/strict';
import RefreshOrchestratorService from '../../services/refreshOrchestratorService.js';
import {AwarenessService} from '../../services/awareness/awarenessService.js';
import {AwarenessStore} from '../../services/awareness/awarenessStore.js';
import {StorageManager} from '../../storage/StorageManager.js';
import {PipelinePersistence} from '../../storage/pipelinePersistence.js';
import {pressureError} from '../../storage/resourceAdmission.js';

const [file, attempt] = process.argv.slice(2);
const now = Number(process.env.FIXTURE_TIME);
const manager = new StorageManager({enabled:true, businessEnabled:true, databasePath:file});
await manager.start();
const pipeline = new PipelinePersistence(manager);
const store = new AwarenessStore();
const service = new AwarenessService({mode:'shadow', sources:[], store, now:() => now});
const at = new Date(now).toISOString();
const articles = Array.from({length:21}, (_, i) => ({id:'article-'+i, revision:1, title:'Financial report '+i,
  url:'https://example.com/report/'+i, provider:'financial', publishedAt:at}));
const state = {meta:{}, market:{}, news:[], countries:{}};
const orchestrator = new RefreshOrchestratorService({
  awarenessService:service, socketServer:{broadcast(){}}, config:{news:{collectInWorker:true, providers:[]}, market:{tickers:[]}, watchlistCountries:[]},
  stateManager:{getSnapshot:()=>state, getSignalCorpus:()=>[], setAdminIntelRawNews(){}, updateIntel:()=>state},
  newsArchive:{getProjection:async()=>({financialSelection:{items:attempt==='restart'?[]:articles}, meta:{revision:attempt==='first'?5:6,asOf:at},
    riskResult:{countries:{},hotspots:[]}, impact:{}, predictions:{}, insights:{}, news:[],signalCorpus:[], marketSignalCorpus:[]})}
});
try {
  await pipeline.hydrate({awarenessStore:store, aiStore:{records:new Map(),recoverInterrupted(){},upsert(x){return x;}},
    aiBudget:{state:{}},marketHistoryStore:{},quotaTracker:{ensureProvider(){},providers:{}}});
  await pipeline.flush();
  orchestrator.collectStoredNews = async () => {
    if (attempt === 'restart') {
      assert.equal(await store.financialContinuations.pending(),null);
      assert.equal(store.events.size,21);
    }
    return {articles:[],sourceMeta:{}};
  };
  if (attempt === 'denied') {
    const request = manager.request.bind(manager);
    manager.request = async (op,...args) => {
      if (op === 'continuation.financialAdmit') throw pressureError({state:'degraded', reason:'fixture-before-admission'});
      return request(op,...args);
    };
    await assert.rejects(orchestrator.executeNewsCycle('manual',{skipSecondary:true}),{code:'STORAGE_RESOURCE_PRESSURE'});
    assert.equal(await store.financialContinuations.pending(),null);
    assert.equal(store.events.size,0);
    await orchestrator.stop();
    assert.ok(orchestrator.deferredAtShutdown.every(row=>row.durable===false));
  } else if (attempt === 'lost') {
    const request = manager.request.bind(manager);
    manager.request = async (op,...args) => {
      const result = await request(op,...args);
      if (op==='continuation.financialPage' && args[0].cursor===0) {
        throw Object.assign(Error('simulated lost response after writer commit'),{code:'STORAGE_OUTCOME_UNKNOWN'});
      }
      return result;
    };
    await assert.rejects(orchestrator.executeNewsCycle('manual',{skipSecondary:true}),{code:'STORAGE_OUTCOME_UNKNOWN'});
    assert.equal(store.events.size,0);
    assert.equal((await store.financialContinuations.pending()).input.after,16);
    await manager.close();
    await orchestrator.stop();
    assert.ok(orchestrator.deferredAtShutdown.some(row=>row.verification==='unknown' && row.durable===false));
  } else if (attempt === 'first') {
    const request = manager.request.bind(manager);
    manager.request = async (op,...args) => {
      if(op==='continuation.financialPage' && args[0].cursor===1) throw pressureError({state:'degraded',reason:'fixture-pressure'});
      return request(op,...args);
    };
    await assert.rejects(orchestrator.executeNewsCycle('startup-news',{skipSecondary:true}),{code:'STORAGE_RESOURCE_PRESSURE'});
    const job = await store.financialContinuations.pending();
    assert.equal(job.input.after,16);
    assert.equal(job.input.context.backfill,true);
    assert.equal(job.input.context.corpusRevision,5);
    await orchestrator.stop();
    assert.equal(orchestrator.deferredAtShutdown.find(row=>row.jobId===job.jobId).durable,true);
  } else {
    await orchestrator.executeNewsCycle('startup-storage',{storageOnly:true,skipSecondary:true});
    assert.equal(store.events.size,21);
    await orchestrator.stop();
  }
} finally {
  await service.stop();
  await manager.close();
}
