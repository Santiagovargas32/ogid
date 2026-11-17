import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {migrate} from '../storage/migrate.js';
import {BusinessRuntime} from '../storage/businessRuntime.js';
import {AdvancedSnapshots} from '../storage/advancedSnapshots.js';
import {freezeMaintenanceInput,compareFrozenMaintenance} from '../scripts/compare-frozen-maintenance.js';

test('frozen A/B/B/A preserves real results, explicit reuse, source and identical FULL seeds',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ogid-frozen-maintenance-')),source=join(dir,'source.sqlite'),input=join(dir,'input.json');
  const db=new Database(source);let runtime;
  try{
    db.pragma('journal_mode=WAL');db.pragma('synchronous=FULL');migrate(db);
    runtime=new BusinessRuntime(db);runtime.configure({rootDir:dir,instruments:[],rss:{rssFeeds:[]},news:{analyzeLimit:3000}});
    const at=new Date().toISOString();
    runtime.services.news.ingest([{id:'report',title:'Official policy statement in Russia',url:'https://example.org/report',publishedAt:at,provider:'rss'}]);
    runtime.advancedSnapshots=new AdvancedSnapshots(runtime);
    const pending=runtime.advancedSnapshots.prepare({options:{countries:['RU']},context:{newsFromStorage:true,snapshot:{}}});
    const job=runtime.advancedSnapshots.claim({jobId:pending.dispatchJobId,owner:'fixture'});
    runtime.rpc=(_operation,input)=>runtime.persistDerived(input);
    await runtime.call({service:'advanced',method:'getSnapshot',args:[{...job.options,force:true,asOf:job.asOf}],context:job.context,analysisJob:job});
    runtime.close();runtime=null;db.close();
    const before=statSync(source),frozen=freezeMaintenanceInput(source,input);
    assert.equal(frozen.completeWindow,true);assert.equal(frozen.articleRows,1);
    const result=await compareFrozenMaintenance(input,join(dir,'comparison'));
    assert.equal(result.parity,true);
    assert.equal(new Set(result.results.map(r=>r.initialDatabaseSHA256)).size,1);
    for(const r of result.results){
      assert.equal(r.sqlite.synchronous,2);assert.equal(r.sqlite.walAutocheckpoint,1000);
      assert.equal(r.operations.filter(o=>o.operation==='advanced.automatic').length,r.mode==='continuous'?1:0);
      assert.equal(r.automatic.analysis_jobs,r.mode==='continuous'?1:0);
      assert.equal(r.counts.analysis_jobs,1);assert.equal(r.counts.analysis_latest,1);
      for(const operation of ['alertSync','conditions','evaluation','advanced.explicit'])assert.ok(r.operations.some(o=>o.operation===operation));
      const explicit=r.operations.find(o=>o.operation==='advanced.explicit');
      if(r.mode==='continuous')assert.equal(explicit.writes.statements,0,'same explicit request reuses published result');
    }
    assert.equal(statSync(source).mtimeMs,before.mtimeMs);assert.equal(statSync(source).size,before.size);
    await assert.rejects(compareFrozenMaintenance(input,join(dir,'comparison')),{code:'EEXIST'});
    const altered=JSON.parse(readFileSync(input));altered.rows[0].payload_json='{}';writeFileSync(join(dir,'altered.json'),JSON.stringify(altered));
    await assert.rejects(compareFrozenMaintenance(join(dir,'altered.json'),join(dir,'invalid')),/hash mismatch/);
  }finally{runtime?.close();if(db.open)db.close();rmSync(dir,{recursive:true,force:true});}
});
