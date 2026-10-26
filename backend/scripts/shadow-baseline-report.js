import { createReadStream, statSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const code = value => typeof value === 'string' && /^[A-Z0-9_]{1,100}$/.test(value) ? value : 'UNKNOWN';
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const counts = values => Object.fromEntries([...values].sort(([a], [b]) => a.localeCompare(b)));
async function scan(file, consume) {
  const bytes = statSync(file).size, hash = createHash('sha256');
  if (bytes) {
    const stream = createReadStream(file, { end: bytes - 1 });
    stream.on('data', value => hash.update(value));
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      try { const item=JSON.parse(line);if(item && typeof item==='object' && !Array.isArray(item))consume(item); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    }
  }
  return { file: basename(file), bytes, sha256: hash.digest('hex') };
}

export async function shadowBaseline(logFile, observerDirectory) {
  const events = new Map(), terminal = new Map(), reconciled = new Set(), reconciling = new Set(), slow = {};
  let firstAt = null, lastAt = null, shutdown = null;
  const log = await scan(logFile, item => {
    const at = time(item.timestamp); if (!at) return;
    firstAt ||= at; lastAt = at;
    if (item.message === 'agent_generation_failed') {
      const key = `${item.jobId}:${item.fence}`;
      if (typeof item.jobId === 'string' && Number.isSafeInteger(item.fence)) terminal.set(key, code(item.code));
    }
    if (['storage_control_reconciling', 'storage_control_reconciled'].includes(item.message) && typeof item.command?.id === 'string')
      (item.message.endsWith('_reconciled') ? reconciled : reconciling).add(item.command.id);
    if (['storage_slow_sql', 'storage_slow_commit', 'storage_wal_checkpoint'].includes(item.message) && Number.isFinite(item.durationMs)) {
      const value = slow[item.message] ||= { count: 0, maxMs: 0 }; value.count++; value.maxMs = Math.max(value.maxMs, item.durationMs);
    }
    if (item.message === 'server_stopped') shutdown = { at, clean: item.primaryCause === null && item.unconfirmedPersistence?.length === 0 && item.cleanupErrors?.length === 0 };
  });
  for (const value of terminal.values()) events.set(value, (events.get(value) || 0) + 1);
  let samples = 0, sampleFirst = null, sampleLast = null, identityChanges = 0, previousIdentity = null;
  const http = {}, statuses = new Map();
  const sampleFile = await scan(join(observerDirectory, 'samples.jsonl'), item => {
    const at = time(item.at); if (!at) return;
    samples++; sampleFirst ||= at; sampleLast = at;
    const identity = JSON.stringify([item.pid, item.startedAt, item.build]);
    if (previousIdentity !== null && previousIdentity !== identity) identityChanges++;
    previousIdentity = identity;
    for (const name of ['health', 'ready', 'agent']) {
      const value = http[name] ||= { observed200: 0, unavailable: 0 };
      value[item.http?.[name] === 200 ? 'observed200' : 'unavailable']++;
    }
    statuses.set(code(String(item.status || '').toUpperCase()), (statuses.get(code(String(item.status || '').toUpperCase())) || 0) + 1);
  });
  const summaryBytes = readFileSync(join(observerDirectory, 'summary.json')), summary = JSON.parse(summaryBytes);
  return { schemaVersion: 'shadow-baseline-v1',
    log: { ...log, firstAt, lastAt, terminalAttempts: terminal.size, terminalCodes: counts(events), slowThresholdLogs: slow,
      controlReconciliation: { started: reconciling.size, recovered: [...reconciling].filter(id => reconciled.has(id)).length }, shutdown },
    observer: { ...sampleFile, summaryHash: createHash('sha256').update(summaryBytes).digest('hex'),
      startedAt: time(summary.startedAt), finishedAt: time(summary.finishedAt), firstSampleAt: sampleFirst, lastSampleAt: sampleLast,
      samples, identityChanges, http, statuses: counts(statuses), completedObservation: summary.completedObservation === true,
      interrupted: summary.state === 'interrupted', terminalSinceCounts: (summary.lastSample?.agent?.sinceCounts || [])
        .filter(row => ['completed', 'failed', 'incomplete', 'running'].includes(row.status) && Number.isSafeInteger(row.count))
        .map(row => ({status: row.status, count: row.count})) },
    interpretation: 'Log terminal attempts and observer sinceCounts have different windows. No inference of semantic quality or 24h acceptance.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw Error('Usage: shadow-baseline-report.js backend.log observer-directory');
  console.log(JSON.stringify(await shadowBaseline(process.argv[2], process.argv[3]), null, 2));
}
