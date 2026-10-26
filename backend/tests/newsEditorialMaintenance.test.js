import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import Database from 'better-sqlite3';
import {migrate} from '../storage/migrate.js';
import {SqlNewsArchive,EDITORIAL_BACKFILL_KEY} from '../storage/sqlNewsArchive.js';
import {BusinessRuntime} from '../storage/businessRuntime.js';

const script=fileURLToPath(new URL('../scripts/news-editorial-backfill.js',import.meta.url));
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'ogid-editorial-maintenance-')),file=join(dir,'archive.sqlite'),db=new Database(file);
  db.pragma('foreign_keys=ON');migrate(db);
  const archive=new SqlNewsArchive(db,{analysisOnly:true}),at='2026-10-20T10:00:00.000Z';
  for(let n=0;n<4;n++)archive.save({id:`article-${n}`,revision:1,title:'Missile strike in Kyiv',url:`https://example.org/${n}`,publishedAt:at,receivedAt:at,archiveLastSeenAt:at,contentRevision:1,usagePolicy:'headline-only-link-out'});
  archive.close();
  // A fresh migration has no historical facets or comparison projection.
  db.exec('DELETE FROM news_editorial_facets');
  return {db,file,close(){db.close();rmSync(dir,{recursive:true,force:true});}};
}
const run=(file,...args)=>execFileSync(process.execPath,[script,...args],{env:{...process.env,STORAGE_DB_PATH:file},encoding:'utf8'}).trim().split('\n').map(JSON.parse);

test('maintenance CLI is read-only by default and durably resumes after a bounded run without configuring acquisition',()=>{
  const f=fixture();try{
    const frozen=f.db.prepare('SELECT * FROM article_revisions ORDER BY article_id,revision').all();
    const originals=f.db.prepare('SELECT payload_json FROM articles ORDER BY article_id').all().map(x=>JSON.parse(x.payload_json));
    const epoch=f.db.prepare("SELECT value_json FROM runtime_meta WHERE key='source.configurationEpoch'").get();
    const status=run(f.file).at(-1);assert.equal(status.apply,false);assert.equal(status.state,null);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM news_editorial_facets').get().n,0);
    const paused=run(f.file,'--apply','--limit=1','--max-pages=1').at(-1);
    assert.equal(paused.event,'paused');assert.equal(paused.state.processed,1);assert.equal(paused.ownerReleased,true);
    const completed=run(f.file,'--apply','--limit=1').at(-1);
    assert.equal(completed.event,'completed');assert.equal(completed.state.processed,4);assert.equal(completed.processedThisRun,3);assert.equal(completed.ownerReleased,true);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM news_editorial_facets').get().n,4);
    assert.equal(f.db.prepare("SELECT value_json FROM runtime_meta WHERE key='source.configurationEpoch'").get(),epoch);
    for(const row of frozen)assert.deepEqual(f.db.prepare('SELECT * FROM article_revisions WHERE article_id=? AND revision=?').get(row.article_id,row.revision),row);
    for(const old of originals){const next=JSON.parse(f.db.prepare('SELECT payload_json FROM articles WHERE article_id=?').get(old.id).payload_json);
      for(const key of ['id','url','publishedAt','receivedAt','contentRevision','archiveLastSeenAt'])assert.deepEqual(next[key],old[key]);
    }
    const counts=f.db.prepare('SELECT count(*) AS n FROM article_revisions').get();
    assert.equal(run(f.file,'--apply').at(-1).processedThisRun,0);
    assert.deepEqual(f.db.prepare('SELECT count(*) AS n FROM article_revisions').get(),counts);
    assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
  }finally{f.close();}
});

test('unconfigured writer replays a lost ACK and rolls back cursor, projections and receipt atomically on failure',async()=>{
  const f=fixture(),runtime=new BusinessRuntime(f.db,()=>{throw Error('PROVIDER_MUST_NOT_RUN');});
  try{
    const input={service:'news',method:'enrichEditorialPage',args:[{limit:1}],requestId:'page-1'};
    const first=await runtime.call(input);assert.equal(first.processed,1);assert.deepEqual(await runtime.call(input),first);
    await assert.rejects(runtime.call({...input,args:[{limit:2}]}),{code:'STORAGE_IDEMPOTENCY_CONFLICT'});
    const before=f.db.prepare('SELECT value_json FROM runtime_meta WHERE key=?').get(EDITORIAL_BACKFILL_KEY);
    const revisions=f.db.prepare('SELECT count(*) AS n FROM article_revisions').get();
    f.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON storage_commands WHEN NEW.request_id='fail-page' BEGIN SELECT RAISE(ABORT,'fixture'); END");
    await assert.rejects(runtime.call({...input,requestId:'fail-page'}));
    assert.deepEqual(f.db.prepare('SELECT value_json FROM runtime_meta WHERE key=?').get(EDITORIAL_BACKFILL_KEY),before);
    assert.deepEqual(f.db.prepare('SELECT count(*) AS n FROM article_revisions').get(),revisions);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM news_editorial_facets').get().n,1);
    assert.equal(runtime.services,null);
  }finally{runtime.close();f.close();}
});

test('maintenance refuses an active owner and invalid page limits before changing historical data',()=>{
  const f=fixture();try{
    f.db.prepare('INSERT INTO storage_writer_owner VALUES(1,?,?,?)').run('fixture-owner',process.pid,new Date().toISOString());
    assert.throws(()=>run(f.file,'--apply'),e=>e.status===1&&e.stdout.includes('STORAGE_WRITER_ACTIVE'));
    assert.throws(()=>run(f.file,'--apply','--limit=101'),e=>e.status===1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM news_editorial_facets').get().n,0);
  }finally{f.close();}
});
