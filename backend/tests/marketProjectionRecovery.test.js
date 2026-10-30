import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../storage/migrate.js';
import { BusinessRuntime } from '../storage/businessRuntime.js';
import { SqlCandleStore, readMeta } from '../storage/sqlRepositories.js';
import { MarketProjectionRepository } from '../storage/marketProjections.js';
import { TECHNICAL_INDICATORS_METHOD_VERSION } from '../services/market/technicalIndicators.js';
import { TechnicalIndicatorService } from '../services/market/technicalIndicatorService.js';
import { CandleWriteJobs } from '../storage/candleWriteJobs.js';

const candle={instrumentId:'us-equity-nvidia',interval:'1day',date:'2026-10-23',openTime:'2026-10-23T13:30:00Z',closeTime:'2026-10-23T20:00:00Z',open:100,high:110,low:90,close:105,volume:100,source:'yahoo',adjusted:true,provenance:{adjustmentMode:'splits'},fetchedAt:'2026-10-24T00:00:00Z'};
const options={now:new Date('2026-10-28T00:00:00Z')};

test('candle commit creates durable projection work that survives restart; duplicates preserve it',()=>{
  const dir=mkdtempSync(join(tmpdir(),'projection-recovery-')),file=join(dir,'db.sqlite');
  let db=new Database(file);
  try{
    migrate(db);
    const store=new SqlCandleStore(db);
    store.upsert([candle],options);
    const pending=new MarketProjectionRepository(new BusinessRuntime(db)).pending();
    assert.equal(pending.length,1);
    assert.equal(pending[0].requiredRevision,1);
    db.close();db=new Database(file);
    new SqlCandleStore(db).upsert([candle],options);
    assert.equal(new MarketProjectionRepository(new BusinessRuntime(db)).pending()[0].requiredRevision,1);
    assert.equal(readMeta(db,'candles.revision:provider-yahoo:us-equity-nvidia:1day:splits',0),1);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('an older projection cannot confirm newer candles and a lost ACK needs no replay',()=>{
  const db=new Database(':memory:');migrate(db);
  try{
    const runtime=new BusinessRuntime(db),repo=new MarketProjectionRepository(runtime),store=new SqlCandleStore(db);
    store.upsert([candle],options);
    const first=repo.pending()[0];
    const revisions={'candles.revision:provider-yahoo:us-equity-nvidia:1day:splits':1};
    const record={kind:'indicators.calculate',input:[{instrumentId:candle.instrumentId,interval:'1day',adjustmentMode:'splits',limit:500}],result:{instrumentId:candle.instrumentId,interval:'1day',adjustmentMode:'splits',seriesRevision:'first',indicators:{},methodVersion:TECHNICAL_INDICATORS_METHOD_VERSION,inputRevisions:revisions,calculatedAt:'2026-10-28T00:00:00Z'}};
    store.upsert([{...candle,close:106}],options);
    assert.equal(repo.publish({key:first.key,revision:1,revisions,record}).confirmed,false);
    assert.equal(repo.pending()[0].requiredRevision,2);
    const nextRevisions={...revisions,[Object.keys(revisions)[0]]:2};
    const result=repo.publish({key:first.key,revision:2,revisions:nextRevisions,record:{...record,result:{...record.result,seriesRevision:'second',inputRevisions:nextRevisions}}});
    assert.equal(result.confirmed,true);
    assert.equal(repo.pending().length,0);
    assert.equal(repo.status({key:first.key}).analysisId,result.analysisId);
    assert.equal(repo.status({key:first.key}).completedRevision,2);
  }finally{db.close();}
});

test('rollback does not leave either candle effects or projection work',()=>{
  const db=new Database(':memory:');migrate(db);
  try{
    const store=new SqlCandleStore(db);
    assert.throws(()=>db.transaction(()=>{store.upsert([candle],options);throw Error('rollback');})());
    assert.equal(db.prepare('SELECT count(*) n FROM candles').get().n,0);
    assert.equal(new MarketProjectionRepository(new BusinessRuntime(db)).pending().length,0);
  }finally{db.close();}
});

test('projection result and completion marker roll back together if confirmation fails',async()=>{
  const db=new Database(':memory:');migrate(db);
  try{
    const runtime=new BusinessRuntime(db),store=new SqlCandleStore(db),repo=new MarketProjectionRepository(runtime);
    runtime.services={candles:store,indicators:new TechnicalIndicatorService({store})};
    store.upsert([candle],options);
    db.exec("CREATE TRIGGER refuse_projection BEFORE UPDATE ON market_projection_state BEGIN SELECT RAISE(ABORT,'confirmation failed'); END");
    await assert.rejects(repo.calculate({key:repo.pending()[0].key}),/confirmation failed/);
    assert.equal(db.prepare('SELECT count(*) n FROM analysis_runs').get().n,0);
    assert.equal(repo.pending().length,1);
  }finally{db.close();}
});

test('completed legacy jobs reconcile current inputs idempotently without replaying candles',async()=>{
  const db=new Database(':memory:');migrate(db);
  try{
    const runtime=new BusinessRuntime(db),store=new SqlCandleStore(db),repo=new MarketProjectionRepository(runtime);
    runtime.services={candles:store,indicators:new TechnicalIndicatorService({store})};
    const jobs=new CandleWriteJobs(runtime),job=jobs.admit({candles:[candle],options});jobs.page(job);
    db.prepare('DELETE FROM market_projection_state').run();
    const [first]=repo.reconcile({jobIds:[job.jobId]});
    assert.equal(first.projections[0].sourceJobId,job.jobId);
    await repo.calculate({key:first.projections[0].key});
    const [second]=repo.reconcile({jobIds:[job.jobId]});
    assert.equal(second.projections[0].state,'complete');assert.equal(second.projections[0].requiredRevision,1);
    assert.equal(db.prepare('SELECT count(*) n FROM candles').get().n,1);
    assert.equal(db.prepare('SELECT count(*) n FROM analysis_runs').get().n,1);
    assert.throws(()=>repo.reconcile({jobIds:[`market-${'a'.repeat(64)}`]}),{code:'MARKET_PROJECTION_CANDLES_UNCONFIRMED'});
  }finally{db.close();}
});

test('five-minute changes invalidate existing projections derived from that series',()=>{
  const db=new Database(':memory:');migrate(db);
  try{
    const store=new SqlCandleStore(db),repo=new MarketProjectionRepository(new BusinessRuntime(db));
    store.upsert([{...candle,interval:'1h'}],options);
    store.upsert([{...candle,interval:'5min'}],options);
    assert.equal(repo.pending().find(row=>row.interval==='1h').requiredRevision,2);
  }finally{db.close();}
});

test('additive migration upgrades schema 029 without modifying existing snapshots',()=>{
  const directory=mkdtempSync(join(tmpdir(),'ogid-upgrade-030-')),db=new Database(':memory:');
  try{
    const migrations=join(directory,'migrations');mkdirSync(migrations);
    for(const name of readdirSync(new URL('../storage/migrations/',import.meta.url)))if(/^\d{3}_.*\.sql$/.test(name)&&Number(name.slice(0,3))<=29)copyFileSync(new URL(`../storage/migrations/${name}`,import.meta.url),join(migrations,name));
    assert.equal(migrate(db,migrations).length,29);
    db.prepare('INSERT INTO runtime_snapshots VALUES(?,?,?)').run('retained','2026-10-28T00:00:00Z',JSON.stringify({id:'old-id',revision:42}));
    const before=db.prepare('SELECT * FROM runtime_snapshots').all();
    assert.equal(migrate(db).length,32);
    assert.deepEqual(db.prepare('SELECT * FROM runtime_snapshots').all(),before);
    assert.equal(new MarketProjectionRepository(new BusinessRuntime(db)).pending().length,0);
  }finally{db.close();rmSync(directory,{recursive:true,force:true});}
});
