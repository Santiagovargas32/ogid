// Upgrade only a new consistent copy. Original database is opened read-only.
import Database from "better-sqlite3";
import { statfsSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createStorageBackup } from "../storage/backup.js";
import { migrate } from "../storage/migrate.js";
const [sourceArg, candidateArg, reportArg] = process.argv.slice(2);
if (!sourceArg || !candidateArg || !reportArg)
  throw Error(
    "Usage: agent-migration-check source.sqlite NEW-candidate.sqlite report.json",
  );
const source = resolve(sourceArg),
  candidate = resolve(candidateArg);
if (
  source === candidate ||
  existsSync(candidate) ||
  candidate.startsWith("/srv/bitcoin/ogid/db/")
)
  throw Error(
    "New validation candidate required outside production DB directory",
  );
const space = statfsSync(dirname(candidate));
if (Number(space.bavail) * Number(space.bsize) < statSync(source).size * 1.5)
  throw Error("Insufficient space for representative migration check");
const report = {
  schemaVersion: "ogid-agent-migration-check-v1",
  originalOpenedReadOnly: true,
  productionModified: false,
  startedAt: new Date().toISOString(),
};
let db;
try {
  report.backup = await createStorageBackup(source, candidate);
  db = new Database(candidate);
  db.pragma("foreign_keys=ON");
  const counts = () =>
    Object.fromEntries(
      [
        "articles",
        "article_revisions",
        "events",
        "candles",
        "analysis_runs",
      ].map((t) => [t, db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n]),
    );
  report.before = counts();
  report.migrations = migrate(db);
  report.after = counts();
  if (JSON.stringify(report.before) !== JSON.stringify(report.after))
    throw Error("Historical counts changed");
  report.integrity = db.pragma("integrity_check", { simple: true });
  report.foreignKeys = db.pragma("foreign_key_check");
  if (report.integrity !== "ok" || report.foreignKeys.length)
    throw Error("Candidate integrity failed");
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.errorCode = e.code || e.message;
  process.exitCode = 1;
} finally {
  db?.close();
  writeFileSync(reportArg, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      status: report.status,
      errorCode: report.errorCode || null,
      report: reportArg,
    }),
  );
}
