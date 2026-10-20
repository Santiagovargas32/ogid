// Explicit validation candidate only. Never opens the active DB for writing.
import Database from "better-sqlite3";
import { readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import { BusinessRuntime } from "../storage/businessRuntime.js";
import { AgentRepository } from "../storage/agentRepository.js";
import { storageConfig } from "../storage/config.js";
const [candidateArg, output, ...options] = process.argv.slice(2);
if (!candidateArg || !output)
  throw Error(
    "Usage: agent-snapshot-check CANDIDATE.sqlite report.json [--as-of=ISO]",
  );
const candidate = realpathSync(resolve(candidateArg));
const envPath = new URL("../.env", import.meta.url);
const active =
  process.env.STORAGE_DB_PATH ||
  (existsSync(envPath)
    ? dotenv.parse(readFileSync(envPath)).STORAGE_DB_PATH
    : null);
const activePath = storageConfig(
  {},
  { STORAGE_DB_PATH: active || undefined },
).databasePath;
if (
  candidate.startsWith("/srv/bitcoin/ogid/db/") ||
  (existsSync(activePath) && candidate === realpathSync(activePath)) ||
  !output.endsWith(".json") ||
  resolve(output) === candidate
)
  throw Error("Validation copy required; active database denied");
const cut = options.find((v) => v.startsWith("--as-of="))?.slice(8);
if (cut && !Number.isFinite(Date.parse(cut))) throw Error("Invalid cutoff");
const report = {
  kind: "representative-copy-snapshot",
  candidate,
  productionModified: false,
};
let db;
try {
  db = new Database(candidate, { fileMustExist: true });
  db.pragma("foreign_keys=ON");
  const repo = new AgentRepository(new BusinessRuntime(db, () => {}), {
    debounceMs: 0,
    ...(cut ? { now: () => Date.parse(cut) } : {}),
  });
  const ids = db
    .prepare(
      "SELECT instrument_id FROM instruments ORDER BY instrument_id LIMIT 50",
    )
    .all()
    .map((r) => r.instrument_id);
  report.selectedInstrumentCount = ids.length;
  report.scope = "up-to-50-stored-instruments; validation-copy-only";
  const owner = randomUUID();
  const queued = repo.enqueue({
    task: "global_intelligence_brief",
    model: "llamacpp/validation-only",
    key: randomUUID(),
    input: { selectedInstrumentIds: ids },
  });
  const job = repo.claim({ owner });
  if (!job || job.jobId !== queued.jobId)
    throw Error("Candidate contains pending work; use a dedicated copy");
  const auth = { jobId: job.jobId, owner, fence: job.fence };
  const start = performance.now();
  const snapshot = repo.snapshot(auth);
  report.snapshotMs = performance.now() - start;
  report.snapshot = snapshot;
  const page = repo.evidence({ snapshotId: snapshot.snapshotId, limit: 20 });
  report.firstPage = {
    items: page.items.length,
    hasMore: page.hasMore,
    bytes: Buffer.byteLength(JSON.stringify(page)),
  };
  repo.state({
    ...auth,
    status: "incomplete",
    errorCode: "AGENT_VALIDATION_ONLY",
  });
  db.close();
  db = new Database(candidate, { readonly: true });
  const recovered = new AgentRepository(
    new BusinessRuntime(db, () => {}),
  ).snapshotInfo(snapshot.snapshotId);
  if (recovered.coverage.sha256 !== snapshot.coverage.sha256)
    throw Error("SNAPSHOT_HASH_CHANGED");
  report.recoveredAfterReopen = true;
  if (report.snapshotMs >= 30000) throw Error("SNAPSHOT_WRITER_DURATION_GATE");
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.errorCode = e.code || e.message;
  process.exitCode = 1;
} finally {
  db?.close();
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      status: report.status,
      snapshotMs: report.snapshotMs,
      errorCode: report.errorCode || null,
      output,
    }),
  );
}
