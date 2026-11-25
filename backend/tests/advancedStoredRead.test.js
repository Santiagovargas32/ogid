import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {createAppServer} from '../server.js';

test('explicit stored advanced and country reads preserve empty, calculated and stale revisions without scheduling work', async () => {
  const dir = mkdtempSync(join(tmpdir(),'ogid-stored-country-'));
  const file = join(dir,'fixture.sqlite');
  const create = () => createAppServer({host:'127.0.0.1',port:0,disableBackgroundRefresh:true,
    storage:{enabled:true,businessEnabled:true,databasePath:file},agent:{mode:'off'},awareness:{mode:'off'},
    market:{provider:'',historyPersist:false,historyDir:dir},news:{providers:[],rssFeeds:[]}});
  let app = create(), db;
  try {
    await app.start();
    db = new Database(file,{readonly:true});
    const counts = () => ['analysis_jobs','analysis_runs','analysis_inputs','analysis_latest'].map(table =>
      db.prepare('SELECT count(*) FROM '+table).pluck().get());
    const get = async (path,extra='') => {
      const response = await fetch('http://127.0.0.1:'+app.server.address().port+path+'?countries=ES&activeWindowHours=24&stored=1'+extra);
      const body = await response.json();
      const expected = extra==='&force=1' ? (path==='/api/intel/anomalies'?404:400) : 200;
      assert.equal(response.status,expected,JSON.stringify(body).slice(0,400));
      return body.data ?? body.error;
    };
    const paths = ['/api/intel/advanced-snapshot','/api/country-instability','/api/intel/country-instability'];
    const initial = counts();
    const projections = ['/api/intel/hotspots-v2','/api/intel/anomalies'];
    await Promise.all([...paths,...projections].map(async path => {
      const cold = await get(path);
      assert.equal(cold.generatedAt,null);
      assert.equal(cold.lifecycle.status,'not-calculated');
      assert.equal(cold.lifecycle.jobId,null);
      assert.equal(cold.lifecycle.calculatedRevision,null);
      assert.ok(cold.lifecycle.requiredRevision);
      assert.equal((await get(path,'&force=1')).code,path==='/api/intel/anomalies'?'NOT_FOUND':'CONFLICTING_ADVANCED_MODE');
    }));
    assert.deepEqual(counts(),initial);
    const options = {countries:['ES'],windowHours:24,activeWindowHours:24,baselineDays:7,maxEvents:450};
    const queued = await app.advancedIntelligenceService.getSnapshot(options);
    await app.storageManager.advancedCoordinator.tasks.get(queued.lifecycle.jobId);
    const complete = counts();
    assert.equal(complete[0],initial[0]+1);
    const warm = await get(paths[0]);
    assert.ok(warm.generatedAt);
    assert.ok(warm.lifecycle.calculatedRevision);
    assert.deepEqual(warm.lifecycle.requiredRevision,warm.lifecycle.calculatedRevision);
    assert.equal(warm.lifecycle.stale,false);
    assert.equal(warm.inputManifest,undefined);
    for (const path of paths.slice(1)) {
      const country = await get(path);
      assert.deepEqual(country.ranking,warm.countryInstability.ranking);
      assert.deepEqual(country.countries,warm.countryInstability.countries);
      assert.equal(country.lifecycle.availableRevision,warm.lifecycle.availableRevision);
    }
    const hotspots = await get(projections[0]), anomalies = await get(projections[1]);
    assert.deepEqual(hotspots.hotspots,warm.hotspots);
    assert.deepEqual(anomalies.items,warm.anomalies.items);
    assert.deepEqual(counts(),complete);
    await app.storageManager.request('domain.call',{service:'news',method:'ingest',args:[[{id:'changed-input',title:'A new revision',url:'https://example.org/revision',publishedAt:new Date().toISOString()}]]});
    const stale = await get(paths[1]);
    assert.equal(stale.generatedAt,warm.generatedAt);
    assert.equal(stale.lifecycle.asOf,warm.lifecycle.asOf);
    assert.equal(stale.lifecycle.status,'stale');
    assert.equal(stale.lifecycle.stale,true);
    assert.notDeepEqual(stale.lifecycle.calculatedRevision,stale.lifecycle.requiredRevision);
    assert.deepEqual(counts(),complete);
    const reader = app.storageManager.analysisManager;
    const dispatch = reader.localRequest.bind(reader);
    reader.localRequest = async (op,input,...rest) => {
      if (input?.analysisJob) throw Object.assign(Error('Fixture calculation failed'),{code:'ANALYSIS_FIXTURE_FAILED'});
      return dispatch(op,input,...rest);
    };
    const failing = await app.advancedIntelligenceService.getSnapshot(options);
    await app.storageManager.advancedCoordinator.tasks.get(failing.lifecycle.jobId);
    const afterFailure = counts();
    const failed = await get(paths[1]);
    assert.equal(failed.generatedAt,warm.generatedAt);
    assert.equal(failed.lifecycle.status,'failed');
    assert.equal(failed.lifecycle.errorCode,'ANALYSIS_FIXTURE_FAILED');
    assert.equal(failed.lifecycle.jobId,failing.lifecycle.jobId);
    assert.deepEqual(counts(),afterFailure);
    const runsByKind = () => db.prepare('SELECT kind,count(*) AS n FROM analysis_runs GROUP BY kind ORDER BY kind').all();
    const advancedRuns = () => db.prepare(`SELECT r.analysis_id,i.analysis_id AS inputs FROM analysis_runs r
      LEFT JOIN analysis_inputs i USING(analysis_id) WHERE kind='advanced.getSnapshot' ORDER BY r.analysis_id`).all();
    const beforeRestart = advancedRuns(), initialKinds = runsByKind();
    await app.stop();
    app = create();
    await app.start();
    const afterStartup = counts();
    assert.deepEqual(advancedRuns(),beforeRestart);
    assert.equal(afterStartup[0],afterFailure[0]);
    assert.equal(afterStartup[3],afterFailure[3]);
    console.log(JSON.stringify({fixture:true,beforeRestart:initialKinds,afterStartup:runsByKind()}));
    const reopened = await get(paths[2]);
    assert.equal(reopened.generatedAt,warm.generatedAt);
    assert.equal(reopened.lifecycle.availableRevision,warm.lifecycle.availableRevision);
    assert.deepEqual(reopened.lifecycle.calculatedRevision,warm.lifecycle.calculatedRevision);
    assert.deepEqual(counts(),afterStartup);
  } finally {
    db?.close();
    await app.stop();
    rmSync(dir,{recursive:true,force:true});
  }
});
