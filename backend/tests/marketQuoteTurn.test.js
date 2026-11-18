import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import Database from 'better-sqlite3';
import {migrate} from '../storage/migrate.js';
import {BusinessRuntime} from '../storage/businessRuntime.js';
import {CycleContinuations} from '../storage/cycleContinuations.js';
import {reserveMarketQuotes} from '../storage/marketQuoteTurn.js';
import {readMarketPresentation} from '../storage/marketPresentation.js';

test('the quote turn, presentation, snapshot and history all roll back on a stale dispatch fence',()=>{
  const db=new Database(':memory:');
  try{
    migrate(db);
    const runtime=new BusinessRuntime(db),ledger=new CycleContinuations(db);
    const at='2026-11-15T12:00:00.000Z',selection={tickers:['GD'],trigger:'manual',selectedAt:at,policyHash:'a'.repeat(64)};
    reserveMarketQuotes(db,{jobId:'quote-test',selection});
    assert.equal(reserveMarketQuotes(db,{jobId:'other',selection}).jobId,'quote-test');
    const claimed=ledger.claim({jobId:'quote-test',owner:'fixture'});
    const job=ledger.advance({...claimed,phase:'request-authorized',input:{...claimed.input,dispatchedAt:at},transitionId:'request'});
    const auth={jobId:job.jobId,owner:job.owner,fence:job.fence,cursor:job.cursor};
    const market={revision:'quote1',updatedAt:at,quotes:{GD:{asOf:at,price:142,source:'yahoo',dataMode:'observed'}}};
    const frame={jobId:'presentation-test',market,analysis:{tickers:['GD'],asOf:at,newsFromStorage:true,corpusOptions:{awarenessMode:'off'}}};
    const save=quoteTurn=>runtime.save('market-publication',{quotes:market.quotes,snapshot:market,presentation:{...frame,quoteTurn}});
    assert.throws(()=>save({...auth,fence:0}),{code:'CONTINUATION_LEASE_LOST'});
    assert.equal(runtime.load('market'),null);assert.equal(readMarketPresentation(runtime),null);
    assert.equal(db.prepare('SELECT count(*) FROM quote_observations').pluck().get(),0);
    assert.equal(ledger.get(auth).phase,'request-authorized');
    save(auth);
    assert.equal(ledger.get(auth).phase,'confirmed');assert.equal(readMarketPresentation(runtime).job.jobId,frame.jobId);
    assert.equal(db.prepare('SELECT count(*) FROM quote_observations').pluck().get(),1);
  }finally{db.close();}
});

for(const attempts of [['deferred','resume'],['deferred','supersede'],['uncertain','reconcile'],['switch']]){
  test('isolated market acquisition and catalog recovery: '+attempts.join(' / '),()=>{
    const directory=mkdtempSync(join(tmpdir(),'ogid-market-turn-'));
    const script=fileURLToPath(new URL('./fixtures/marketQuoteTurn.mjs',import.meta.url));
    const at=new Date().toISOString();
    try{
      for(const attempt of attempts)execFileSync(process.execPath,['--require','./tests/testSetup.cjs',script,directory,attempt,at],{timeout:30000});
    }finally{rmSync(directory,{recursive:true,force:true});}
  });
}
