import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import Database from 'better-sqlite3';
import {BusinessRuntime} from '../storage/businessRuntime.js';
import {migrate} from '../storage/migrate.js';
import {CycleContinuations} from '../storage/cycleContinuations.js';
import {MARKET_FRAME,readMarketPresentation,finishMarketPresentation} from '../storage/marketPresentation.js';
import {writeMeta} from '../storage/sqlRepositories.js';

const asOf='2026-11-15T12:00:00.000Z';
function frame(jobId,mode='off'){
  return {jobId,market:{revision:'r-'+jobId,quotes:{}},analysis:{asOf,newsFromStorage:true,corpusOptions:{awarenessMode:mode},tickers:[]}};
}
function result(job){
  const {basis,watermark}=job.input;
  return {insights:[],impact:{updatedAt:asOf},predictions:{updatedAt:asOf},
    newsCoverage:{asOf,revision:basis.news,awarenessRevision:basis.awareness,awarenessAdmission:basis.admission,inputManifest:{revisionWatermark:watermark}}};
}

test('market presentation rolls back with its cursor, fences superseded work and discards changed source visibility',()=>{
  const db=new Database(':memory:');
  try{
    migrate(db);
    const runtime=new BusinessRuntime(db),ledger=new CycleContinuations(db);
    const history=()=>db.prepare("SELECT count(*) AS n FROM analysis_runs JOIN analysis_inputs USING(analysis_id) WHERE kind='market.analyze'").get().n;
    const claim=jobId=>ledger.claim({jobId,owner:'fixture'});
    const auth=job=>({owner:job.owner,fence:job.fence,cursor:job.cursor,jobId:job.jobId});
    db.exec(`CREATE TRIGGER reject_frame BEFORE INSERT ON runtime_snapshots WHEN NEW.kind='${MARKET_FRAME}' BEGIN SELECT RAISE(ABORT,'reject frame'); END`);
    assert.throws(()=>runtime.save('market-publication',{quotes:{},snapshot:{revision:'rejected'},presentation:frame('rejected')}),/reject frame/);
    assert.equal(runtime.load('market'),null);
    assert.equal(readMarketPresentation(runtime),null);
    assert.equal(ledger.pending().length,0);
    db.exec('DROP TRIGGER reject_frame');
    runtime.save('market-presentation',frame('a'));
    const a=claim('a');
    db.exec("CREATE TRIGGER reject_result BEFORE INSERT ON runtime_snapshots WHEN NEW.kind='market-presentation-result-v1' BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
    assert.throws(()=>finishMarketPresentation(runtime,{auth:auth(a),projection:result(a)}),/fixture failure/);
    assert.equal(ledger.get(a).cursor,0);assert.equal(readMarketPresentation(runtime).projection,null);
    assert.equal(history(),0);
    db.exec('DROP TRIGGER reject_result');
    runtime.save('market-presentation',frame('b','visible'));
    assert.equal(ledger.get(a).input.replacedBy,'b');
    assert.equal(finishMarketPresentation(runtime,{auth:auth(a),projection:result(a)}).job.phase,'superseded');
    const b=claim('b');
    assert.throws(()=>finishMarketPresentation(runtime,{auth:{...auth(b),fence:0},projection:result(b)}),{code:'CONTINUATION_LEASE_LOST'});
    const expired=ledger.row('b');expired.descriptor.leaseUntil=0;ledger.save(expired);
    assert.throws(()=>finishMarketPresentation(runtime,{auth:auth(b),projection:result(b)}),{code:'CONTINUATION_LEASE_LOST'});
    const reclaimed=ledger.claim({jobId:'b',owner:'successor'});
    assert.ok(reclaimed.fence>b.fence);
    runtime.save('awareness',{sourceStatus:[{sourceId:'fixture',admissionState:'active'}]});
    assert.equal(finishMarketPresentation(runtime,{auth:auth(reclaimed),projection:result(reclaimed)}).job.phase,'discarded');
    assert.equal(history(),0);
    runtime.save('market-presentation',frame('c'));const c=claim('c');
    const closed=finishMarketPresentation(runtime,{auth:auth(c),projection:result(c)});
    assert.equal(closed.job.phase,'published');
    assert.equal(finishMarketPresentation(runtime,{auth:auth(c),projection:result(c)}).job.replayed,true);
    assert.equal(history(),1);
    assert.deepEqual(readMarketPresentation(runtime).projection,result(c));
    runtime.save('market-presentation-result-v1',{jobId:c.jobId,projection:{...result(c),insights:['different result']}});
    assert.throws(()=>readMarketPresentation(runtime),{code:'CONTINUATION_EFFECT_MISMATCH'});
    writeMeta(db,'news.meta',{revision:5});
    assert.equal(readMarketPresentation(runtime).projection,null);
  }finally{db.close();}
});

test('an isolated market runtime recovers a deferred presentation on reboot and reuses the committed result after a lost ACK',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ogid-presentation-'));
  const fixture=fileURLToPath(new URL('./fixtures/marketPresentation.mjs',import.meta.url));
  try{
    for(const attempt of ['defer','recover','reuse']){
      execFileSync(process.execPath,['--require','./tests/testSetup.cjs',fixture,dir,attempt,asOf],{timeout:30000});
    }
    const db=new Database(join(dir,'fixture.sqlite'),{readonly:true});
    try{
      assert.equal(db.prepare('SELECT count(*) FROM quote_observations').pluck().get(),0);
      assert.equal(db.prepare("SELECT count(*) FROM acquisition_jobs WHERE json_extract(job_json,'$.scope')='market:presentation'").pluck().get(),1);
      const rows=db.prepare("SELECT parameters_json,manifest_json,inputs_as_of FROM analysis_inputs JOIN analysis_runs USING(analysis_id) WHERE kind='market.analyze'").all();
      assert.equal(rows.length,1);
      assert.equal(rows[0].inputs_as_of,asOf);
      assert.equal(JSON.parse(rows[0].manifest_json).inputsAsOf,asOf);
      const [input]=JSON.parse(rows[0].parameters_json);
      assert.equal(input.asOf,asOf);
      assert.equal(input.marketQuotes.GD.price,101);
      assert.equal(input.corpusOptions.revisionWatermark,0);
    }finally{db.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});
