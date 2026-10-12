import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SqlResearchStore } from '../storage/sqlRepositories.js';
import { migrate } from '../storage/migrate.js';
import { backupLegacy, verifyLegacyBackup } from '../storage/legacyBackup.js';
import { EventLedger } from '../services/research/eventLedger.js';
import { StorageManager } from '../storage/StorageManager.js';

test('SQL research exceeds 20000 historical rows, writes incrementally and rolls back conflicts',()=>{
  const db=new Database(':memory:');migrate(db);const store=new SqlResearchStore(db);
  const rows=Array.from({length:20001},(_,i)=>[`fact-${i}`,{id:`fact-${i}`,timestamp:'2026-10-12',provenance:{source:'fixture'}}]);
  store.transact(s=>{for(const [id,row]of rows)s.companyFacts[id]=row;});
  assert.equal(db.prepare("SELECT count(*) AS n FROM research_rows").get().n,20001);
  let writes=0;db.exec("CREATE TABLE write_probe(n INTEGER); INSERT INTO write_probe VALUES(0); CREATE TRIGGER count_research AFTER UPDATE ON research_rows BEGIN UPDATE write_probe SET n=n+1; END;");
  store.transact(s=>{s.companyFacts['fact-0'].updated=true;});
  writes=db.prepare('SELECT n FROM write_probe').get().n;assert.equal(writes,1);
  assert.throws(()=>store.transact(s=>{s.companyFacts['fact-1']={bad:1};throw Error('rollback');}));
  assert.deepEqual(store.getRow('companyFacts','fact-1'),rows[1][1]);assert.equal(store.state.revision,2);db.close();
});

test('explicit migration backup verifies original bytes and refuses changing sources',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ogid-backup-ledger-'));
  try{const source=join(dir,'ledger.json');writeFileSync(source,'{"revision":1115}');const before=readFileSync(source);
    const manifest=await backupLegacy({research:source},join(dir,'backup'));
    assert.equal((await verifyLegacyBackup(manifest)).verified,true);assert.deepEqual(readFileSync(source),before);
    writeFileSync(source,'{"revision":1116}');await assert.rejects(verifyLegacyBackup(manifest),{code:'STORAGE_IMPORT_SOURCE_CHANGED'});
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a blocked/terminated analysis worker leaves transactional persistence available',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ogid-worker-isolation-')),manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:join(dir,'db.sqlite')});
  try{await manager.start();await manager.request('domain.configure',{rss:{rssFeeds:[]}});
    const worker=manager.analysisManager.worker;
    const {MessageChannel}=await import('node:worker_threads');const channel=new MessageChannel();
    // A synchronous CPU load on the analysis worker is emulated by its real termination;
    // delayed responses and unknown outcomes are covered by StorageManager deadline tests.
    await worker.terminate();await new Promise(resolve=>setImmediate(resolve));
    await assert.rejects(manager.request('domain.call',{service:'advanced',method:'getSnapshot',args:[{}]}),{code:'STORAGE_NOT_READY'});
    const saved=await manager.request('runtime.save',{kind:'test-isolation',payload:{revision:7}});assert.equal(saved.persisted,true);
    assert.deepEqual(await manager.request('runtime.load',{kind:'test-isolation'}),{revision:7});
    assert.equal((await manager.request('storage.verify')).integrity[0].integrity_check,'ok');channel.port1.close();channel.port2.close();
  }finally{await manager.close();rmSync(dir,{recursive:true,force:true});}
});

test('awareness events still commit after the research event table reaches the legacy limit',()=>{
  const db=new Database(':memory:');migrate(db);const store=new SqlResearchStore(db);
  const insert=db.prepare("INSERT INTO research_rows VALUES('events',?,?)");
  db.transaction(()=>{for(let i=0;i<20000;i++)insert.run(`legacy-${i}`,JSON.stringify({eventId:`legacy-${i}`,revision:1,evidence:[],identityVersion:'source-publication-v2'}));})();
  const ledger=new EventLedger({store});
  const result=ledger.ingest([{id:'awareness-new',title:'Fixture official awareness announcement',url:'https://official.example/fixture',publishedAt:'2026-10-12T12:00:00Z',receivedAt:'2026-10-12T12:01:00Z',sourceId:'fixture-official',provenance:{sourceId:'fixture-official'}}],{sourceId:'awareness'});
  assert.equal(db.prepare("SELECT count(*) AS n FROM research_rows WHERE collection='events'").get().n,20001);
  assert.ok(Object.values(store.view('events')).some(e=>e.evidence.some(v=>v.sourceId==='fixture-official')));
  assert.equal(db.pragma('integrity_check',{simple:true}),'ok');db.close();
});
