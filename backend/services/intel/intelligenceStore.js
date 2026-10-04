import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";

export function stableJson(value) {
  const sort = (item) => Array.isArray(item) ? item.map(sort) : item && typeof item === "object"
    ? Object.fromEntries(Object.keys(item).sort().filter((key) => item[key] !== undefined).map((key) => [key, sort(item[key])])) : item;
  return JSON.stringify(sort(value));
}
export const contentHash = (value) => createHash("sha256").update(stableJson(value)).digest("hex");
const TYPES = new Set(["evidence", "forecast", "resolution", "analysis", "checkpoint"]);

// Plan sections 3, 8, 10. One asynchronous writer; every visible forecast is
// committed before publication. This store must not be shared by Node workers.
export class IntelligenceStore {
  constructor({ rootDir = null, now = Date.now, retentionDays = 90 } = {}) {
    this.rootDir = rootDir;
    this.now = now;
    this.retentionDays = retentionDays;
    this.records = new Map([...TYPES].map((type) => [type, new Map()]));
    this.evidenceVersions = new Map();
    this.sequence = 0;
    this.chain = Promise.resolve();
    this.status = { healthy: true, writes: 0, deduplicated: 0, repairedTails: 0, lastError: null };
    this.ready = this.hydrate().catch((error) => this.fail(error));
  }

  fail(error) {
    this.status.healthy = false;
    this.status.lastError = error?.code || "INTELLIGENCE_STORAGE_ERROR";
  }

  apply(row) {
    this.sequence = Math.max(this.sequence, row.sequence);
    const map = this.records.get(row.type);
    if (!map) throw Object.assign(new Error("Unknown journal type."), { code: "JOURNAL_CORRUPT" });
    map.set(row.id, row);
    if (row.type === "evidence") {
      const revisions = this.evidenceVersions.get(row.id) || [];
      revisions.push(row);
      this.evidenceVersions.set(row.id, revisions);
    }
  }

  async hydrate() {
    if (!this.rootDir) return;
    const dir = path.join(this.rootDir, "journal");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const files = (await readdir(dir)).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
    for (const name of files) {
      const file = path.join(dir, name);
      let validBytes = 0;
      let pending = null;
      const consume = (line) => {
        const row = JSON.parse(line);
        const { checksum, ...body } = row;
        if (checksum !== contentHash(body) || row.schemaVersion !== 1 || !TYPES.has(row.type)
            || !Number.isSafeInteger(row.sequence) || row.sequence <= this.sequence) {
          throw Object.assign(new Error("Journal integrity check failed."), { code: "JOURNAL_CORRUPT" });
        }
        this.apply(row);
      };
      // Delay one line: only a torn last line is recoverable. Interior corruption
      // remains visible and disables writes instead of silently losing history.
      for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
        if (pending !== null) { consume(pending); validBytes += Buffer.byteLength(pending) + 1; }
        pending = line;
      }
      if (pending !== null) {
        try { consume(pending); }
        catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          const handle = await open(file, "r+");
          try { await handle.truncate(validBytes); await handle.sync(); } finally { await handle.close(); }
          this.status.repairedTails += 1;
          continue;
        }
        const handle = await open(file, "a+");
        try {
          const stat = await handle.stat();
          if (stat.size > 0) {
            const last = Buffer.alloc(1);
            await handle.read(last, 0, 1, stat.size - 1);
            if (last[0] !== 10) { await handle.write("\n"); await handle.sync(); this.status.repairedTails += 1; }
          }
        } finally { await handle.close(); }
      }
    }
    this.pruneMemory();
  }

  pruneMemory() {
    const cutoff = this.now() - this.retentionDays * 86400000;
    for (const [id, versions] of this.evidenceVersions) {
      // Retain the last revision of still-upcoming events even if first seen long ago.
      const recent = versions.filter((row) => Date.parse(row.recordedAt) >= cutoff || Date.parse(row.payload.scheduledAt) >= this.now());
      if (recent.length) this.evidenceVersions.set(id, recent);
      else { this.evidenceVersions.delete(id); this.records.get("evidence").delete(id); }
    }
  }

  async put(type, id, payload, { immutable = false } = {}) {
    if (!TYPES.has(type) || typeof id !== "string" || !id) throw new Error("Invalid journal record.");
    const safePayload = JSON.parse(stableJson(payload));
    const work = async () => {
      await this.ready;
      if (!this.status.healthy) throw Object.assign(new Error("Evidence storage unavailable."), { code: this.status.lastError });
      const previous = this.records.get(type).get(id);
      const fingerprint = contentHash(safePayload);
      if (previous?.fingerprint === fingerprint) { this.status.deduplicated += 1; return structuredClone(previous.payload); }
      if (immutable && previous) throw Object.assign(new Error("An issued record cannot be replaced."), { code: "IMMUTABLE_RECORD" });
      const row = { schemaVersion: 1, sequence: this.sequence + 1, type, id, recordedAt: new Date(this.now()).toISOString(), fingerprint, payload: safePayload };
      row.checksum = contentHash(row);
      if (this.rootDir) {
        const dir = path.join(this.rootDir, "journal");
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const handle = await open(path.join(dir, `${row.recordedAt.slice(0, 10)}.jsonl`), "a", 0o600);
        try { await handle.write(`${JSON.stringify(row)}\n`); await handle.sync(); } finally { await handle.close(); }
      }
      this.apply(row);
      this.status.writes += 1;
      if (this.status.writes % 500 === 0) this.pruneMemory();
      return structuredClone(safePayload);
    };
    const next = this.chain.then(work);
    this.chain = next.catch((error) => { if (error.code !== "IMMUTABLE_RECORD") this.fail(error); });
    return next;
  }

  get(type, id) { return structuredClone(this.records.get(type)?.get(id)?.payload ?? null); }
  list(type) { return [...(this.records.get(type)?.values() || [])].map((row) => structuredClone(row.payload)); }

  evidenceAt(asOf = new Date(this.now()).toISOString()) {
    const cutoff = Date.parse(asOf);
    const result = [];
    for (const versions of this.evidenceVersions.values()) {
      const row = versions.findLast((item) => Date.parse(item.payload.availableAt) <= cutoff && Date.parse(item.recordedAt) <= cutoff);
      if (row) result.push(structuredClone(row.payload));
    }
    return result;
  }

  async savePacket(packet) {
    await this.ready;
    if (!this.status.healthy) throw new Error("Evidence storage unavailable.");
    const packetHash = contentHash(packet);
    if (this.rootDir) {
      const dir = path.join(this.rootDir, "packets");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const target = path.join(dir, `${packetHash}.json`);
      const temp = `${target}.${process.pid}.tmp`;
      const handle = await open(temp, "w", 0o600);
      try { await handle.writeFile(stableJson(packet)); await handle.sync(); } finally { await handle.close(); }
      await rename(temp, target);
    }
    return packetHash;
  }

  async readPacket(hash) {
    if (!/^[a-f0-9]{64}$/.test(hash) || !this.rootDir) return null;
    const packet = JSON.parse(await readFile(path.join(this.rootDir, "packets", `${hash}.json`), "utf8"));
    if (contentHash(packet) !== hash) throw new Error("Packet integrity check failed.");
    return packet;
  }

  async consolidateDay(day = new Date(this.now()).toISOString().slice(0, 10)) {
    if (!this.rootDir || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    await this.chain;
    const evidence = this.evidenceAt().filter((item) => item.availableAt.startsWith(day));
    const summary = { schemaVersion: "daily-evidence-v1", day, generatedAt: new Date(this.now()).toISOString(),
      evidenceIds: evidence.map((item) => item.evidenceId),
      events: Object.fromEntries([...new Set(evidence.map((item) => item.eventKey))].map((key) => [key,
        evidence.filter((item) => item.eventKey === key).map((item) => ({ evidenceId: item.evidenceId, title: item.title }))])),
      forecasts: this.list("forecast").filter((item) => item.issuedAt.startsWith(day)).map((item) => item.forecastId) };
    const dir = path.join(this.rootDir, "daily");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = path.join(dir, `${day}.${process.pid}.tmp`);
    await writeFile(temp, stableJson(summary), { mode: 0o600 });
    await rename(temp, path.join(dir, `${day}.json`));
    return summary;
  }

  summary() { return { ...this.status, sequence: this.sequence, persistenceEnabled: Boolean(this.rootDir),
    retentionDaysInMemory: this.retentionDays, counts: Object.fromEntries([...this.records].map(([key, map]) => [key, map.size])) }; }
  async flush() { await this.ready; await this.chain; }
}
