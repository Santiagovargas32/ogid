// Prueba aislada: lee un snapshot real y escribe exclusivamente en un directorio
// temporal. No migra datos ni configura el almacenamiento de producción.
import { mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

if (isMainThread) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const input = process.argv[2] || path.join(root, 'backend/data/intel/research-news.json');
  const scratch = mkdtempSync(path.join(tmpdir(), 'ogid-storage-'));
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  try {
    const result = await new Promise((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: { input, scratch } });
      let result;
      worker.on('message', message => { result = message; });
      worker.on('error', reject);
      worker.on('exit', code => code !== 0 ? reject(new Error(`Worker exit ${code}`)) : result ? resolve(result) : reject(new Error('No benchmark result')));
    });
    lag.disable();
    console.log(JSON.stringify({ ...result, parentEventLoop: { p99Ms: Number((lag.percentile(99) / 1e6).toFixed(2)), maxMs: Number((lag.max / 1e6).toFixed(2)) }, limitation: 'Un único ensayo aislado con datos locales y caché del SO; no es una prueba HTTP de producción ni una migración.' }, null, 2));
  } finally {
    lag.disable();
    rmSync(scratch, { recursive: true, force: true });
  }
} else {
  const { DatabaseSync } = await import('node:sqlite');
  const timings = {};
  const measure = (label, fn) => {
    const start = performance.now(); const result = fn();
    timings[label] = Number((performance.now() - start).toFixed(2)); return result;
  };
  const bytes = statSync(workerData.input).size;
  const snapshot = measure('readAndParseJsonMs', () => JSON.parse(readFileSync(workerData.input, 'utf8')));
  if (snapshot.schemaVersion !== 'news-archive-v1' || !Array.isArray(snapshot.articles) || !snapshot.articles.length) throw new Error('Expected nonempty news-archive-v1');
  const serialized = measure('serializeFullJsonMs', () => JSON.stringify(snapshot));
  measure('writeAndRenameFullJsonMs', () => { writeFileSync(path.join(workerData.scratch, 'snapshot.tmp'), serialized, { mode: 0o600 }); renameSync(path.join(workerData.scratch, 'snapshot.tmp'), path.join(workerData.scratch, 'snapshot.json')); });
  const db = new DatabaseSync(path.join(workerData.scratch, 'benchmark.sqlite'));
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;');
    const version = db.prepare('SELECT sqlite_version() AS version').get().version;
    const parts = version.split('.').map(Number);
    if (parts[0] < 3 || (parts[0] === 3 && (parts[1] < 51 || (parts[1] === 51 && parts[2] < 3)))) throw new Error('This benchmark requires SQLite >= 3.51.3');
    db.exec(`CREATE TABLE articles(id TEXT PRIMARY KEY, published_at TEXT, title TEXT NOT NULL, payload TEXT NOT NULL) STRICT;
      CREATE INDEX articles_by_time ON articles(published_at DESC, id DESC);
      CREATE VIRTUAL TABLE news_fts USING fts5(article_id UNINDEXED, title, excerpt);
      CREATE TABLE revisions(article_id TEXT NOT NULL REFERENCES articles(id), revision INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(article_id,revision)) STRICT;`);
    const insert = db.prepare('INSERT INTO articles VALUES(?,?,?,?)');
    const fts = db.prepare('INSERT INTO news_fts VALUES(?,?,?)');
    measure('importAllRowsAndFtsMs', () => {
      for (let offset = 0; offset < snapshot.articles.length; offset += 500) {
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const article of snapshot.articles.slice(offset, offset + 500)) { insert.run(article.id, article.publishedAt || null, article.title || '', JSON.stringify(article)); fts.run(article.id, article.title || '', article.excerpt || ''); }
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      }
    });
    const rowCount = db.prepare('SELECT count(*) AS n FROM articles').get().n;
    if (rowCount !== snapshot.articles.length) throw new Error('Row count mismatch');
    const update = db.prepare('UPDATE articles SET payload=? WHERE id=?');
    const revision = db.prepare('INSERT INTO revisions VALUES(?,?,?)');
    const batch = snapshot.articles.slice(0, 500);
    measure('update500RowsAndAppendRevisionsMs', () => {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const article of batch) { const revised = JSON.stringify({ ...article, benchmarkRevision: 1 }); update.run(revised, article.id); revision.run(article.id, 1, JSON.stringify(article)); }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
    const latest = measure('queryLatest50Ms', () => db.prepare('SELECT payload FROM articles ORDER BY published_at DESC, id DESC LIMIT 50').all());
    const restored = JSON.parse(db.prepare('SELECT payload FROM articles WHERE id=?').get(batch[0].id).payload);
    if (restored.id !== batch[0].id || restored.benchmarkRevision !== 1) throw new Error('Roundtrip failed');
    const token = snapshot.articles.map(article => article.title?.match(/[A-Za-z]{4,}/)?.[0]).find(Boolean);
    const matches = measure('ftsSearch20Ms', () => token ? db.prepare('SELECT article_id FROM news_fts WHERE news_fts MATCH ? LIMIT 20').all(token) : []);
    const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
    if (integrity !== 'ok') throw new Error(`Integrity check: ${integrity}`);
    const wal = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    parentPort.postMessage({ observedAt: new Date().toISOString(), node: process.versions.node, sqlite: version, archiveBytes: bytes, articles: rowCount, batchUpdated: batch.length, queryRows: latest.length, ftsMatches: matches.length, integrity, checkpointBusy: wal.busy, databaseBytes: statSync(path.join(workerData.scratch, 'benchmark.sqlite')).size, timings });
  } finally { db.close(); }
}
