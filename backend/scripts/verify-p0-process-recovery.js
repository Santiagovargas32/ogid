// Starts only owned child processes, using a fresh isolated database and no upstreams.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { SqlResearchStore } from '../storage/sqlRepositories.js';

const backend = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'ogid-process-recovery-'));
const databasePath = join(directory, 'fixture.sqlite');
const npmCli = process.env.OGID_NPM_CLI || join(dirname(dirname(process.execPath)), 'lib/node_modules/npm/bin/npm-cli.js');
const result = { node: process.version, command: 'npm start', supervisor: false };
const children = [];
async function start() {
  const child = spawn(process.execPath, [npmCli, 'start'], {
    cwd: backend, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
      NODE_ENV: 'test', PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'info',
      STORAGE_ENABLED: '1', STORAGE_BUSINESS_ENABLED: '1', STORAGE_REQUIRE_IMPORT: '0', STORAGE_DB_PATH: databasePath,
      DISABLE_BACKGROUND_REFRESH: '1', MARKET_PROVIDER: '', MARKET_FALLBACK_PROVIDER: '',
      AI_PROVIDER: 'none', AI_MODE: 'off', AWARENESS_MODE: 'off' }
  });
  children.push(child);
  let output = '', port;
  child.stdout.on('data', bytes => {
    output += bytes.toString();
    for (const line of output.split('\n')) {
      try { const entry = JSON.parse(line); if (entry.message === 'server_started') port = entry.port; } catch {}
    }
    output = output.slice(-16384);
  });
  child.stderr.resume();
  const deadline = Date.now() + 30000;
  while (!port) {
    if (child.exitCode !== null || Date.now() > deadline) throw Error('process-startup-failed');
    await delay(25);
  }
  const base = `http://127.0.0.1:${port}`;
  const health = await fetch(`${base}/api/health`);
  if (!health.ok) throw Error(`health-${health.status}`);
  return {child, base};
}
async function stop(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit');
  process.kill(-child.pid, signal);
  await exit;
}
try {
  const first = await start();
  const fixture = { companyId: 'p0-process-fixture', metrics: { observed: 123 },
    provenance: { source: 'controlled-fixture', testOnly: true }, updatedAt: new Date().toISOString() };
  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');
  new SqlResearchStore(db).transact(state => { state.companyFacts[fixture.companyId] = fixture; });
  db.close();
  await stop(first.child, 'SIGKILL');
  const second = await start();
  const response = await fetch(`${second.base}/api/research/companyfacts?companyId=${fixture.companyId}`);
  const restored = (await response.json()).data;
  result.newProcess = first.child.pid !== second.child.pid;
  result.httpStatus = response.status;
  result.persistedFixture = JSON.stringify(restored) === JSON.stringify(fixture);
  result.provenancePreserved = restored?.provenance?.source === fixture.provenance.source;
  const check = new Database(databasePath, {readonly: true});
  result.integrity = check.pragma('integrity_check'); result.foreignKeys = check.pragma('foreign_key_check'); check.close();
  if (!result.newProcess || !result.persistedFixture || !result.provenancePreserved || result.integrity[0].integrity_check !== 'ok' || result.foreignKeys.length) throw Error('process-recovery-invalid');
} catch (error) { result.failure = error.message; process.exitCode = 1; }
finally {
  for (const child of children) await stop(child, 'SIGTERM').catch(() => {});
  await writeFile(process.env.OGID_PROCESS_ARTIFACT || join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
