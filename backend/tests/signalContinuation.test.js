import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

for (const domain of ['news','market']) test(domain+' signals survive pressure and restart, and a lost ACK does not apply twice', () => {
  const dir = mkdtempSync(join(tmpdir(),'ogid-signals-recovery-'));
  try {
    const file = fileURLToPath(new URL('./fixtures/signalContinuation.mjs',import.meta.url));
    for (const attempt of ['defer','recover']) {
      execFileSync(process.execPath,['--require','./tests/testSetup.cjs',file,dir,attempt,domain],{timeout:30000});
    }
  } finally {
    rmSync(dir,{recursive:true,force:true});
  }
});

test('a failed signal receipt rolls back the signal, its cut and its audit', () => {
  const dir = mkdtempSync(join(tmpdir(),'ogid-signals-rollback-'));
  try {
    const file = fileURLToPath(new URL('./fixtures/signalContinuation.mjs',import.meta.url));
    execFileSync(process.execPath,['--require','./tests/testSetup.cjs',file,dir,'rollback'],{timeout:30000});
  } finally {
    rmSync(dir,{recursive:true,force:true});
  }
});

for (const [attempt,description] of [
  ['stage-pressure','a rejected admission preserves both cuts and coalesces concurrent duplicates'],
  ['stage-unknown','an unknown admission receipt preserves both cuts without a duplicate'],
  ['fence','a replaced lease cannot apply or replay a measurement'],
  ['close-healthy','shutdown reports a measurement whose admission received no confirmation'],
  ['close-broken','shutdown preserves unknown verification when the writer cannot answer']
]) test(description, () => {
  const dir = mkdtempSync(join(tmpdir(),'ogid-signals-stage-'));
  try {
    const file = fileURLToPath(new URL('./fixtures/signalContinuation.mjs',import.meta.url));
    execFileSync(process.execPath,['--require','./tests/testSetup.cjs',file,dir,attempt],{timeout:30000});
  } finally {
    rmSync(dir,{recursive:true,force:true});
  }
});
