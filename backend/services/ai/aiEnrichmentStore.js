import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sanitizeSensitiveData } from "../../utils/sanitize.js";

const ALLOWED_STATUSES = new Set(["pending", "running", "ready", "rejected", "failed", "stale"]);

export class AiEnrichmentStore {
  constructor({ persistencePath = null, maxRecords = 1_000 } = {}) {
    this.persistencePath = persistencePath;
    this.maxRecords = Math.max(20, Number(maxRecords) || 1_000);
    this.records = new Map();
    this.hydrate();
    this.recoverInterrupted();
  }

  upsert(record) {
    if (!record?.enrichmentId) throw new Error("AI enrichmentId is required.");
    if (!ALLOWED_STATUSES.has(record.status)) throw new Error(`Unsupported AI enrichment status: ${record.status}`);
    const safe = sanitizeSensitiveData(structuredClone(record));
    this.records.set(safe.enrichmentId, safe);
    this.trim();
    this.persist();
    return structuredClone(safe);
  }

  get(enrichmentId) {
    const record = this.records.get(enrichmentId);
    return record ? structuredClone(record) : null;
  }

  findAcceptedByCacheKey(cacheKey) {
    return [...this.records.values()]
      .filter((record) => record.cacheKey === cacheKey && ["ready", "stale"].includes(record.status) && record.output)
      .sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0))
      .map((record) => structuredClone(record))[0] || null;
  }

  list({ status = "", kind = "", page = 1, pageSize = 50 } = {}) {
    const normalizedStatus = String(status || "").trim().toLowerCase();
    const normalizedKind = String(kind || "").trim().toLowerCase();
    const filtered = [...this.records.values()]
      .filter((record) => !normalizedStatus || record.status === normalizedStatus)
      .filter((record) => !normalizedKind || record.kind === normalizedKind)
      .sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0));
    const resolvedPageSize = Math.max(1, Math.min(250, Number(pageSize) || 50));
    const totalPages = Math.max(1, Math.ceil(filtered.length / resolvedPageSize));
    const resolvedPage = Math.max(1, Math.min(totalPages, Number(page) || 1));
    const offset = (resolvedPage - 1) * resolvedPageSize;
    return {
      items: structuredClone(filtered.slice(offset, offset + resolvedPageSize)),
      pagination: { page: resolvedPage, pageSize: resolvedPageSize, totalItems: filtered.length, totalPages }
    };
  }

  summary() {
    const counts = {};
    for (const record of this.records.values()) counts[record.status] = (counts[record.status] || 0) + 1;
    return { total: this.records.size, counts, persistenceEnabled: Boolean(this.persistencePath) };
  }

  recoverInterrupted() {
    let changed = false;
    const now = new Date().toISOString();
    for (const [id, record] of this.records) {
      if (!["pending", "running"].includes(record.status)) continue;
      this.records.set(id, {
        ...record,
        status: "failed",
        output: null,
        updatedAt: now,
        validation: { schemaValid: false, groundingValid: false, codes: ["RESTART_INTERRUPTED"] }
      });
      changed = true;
    }
    if (changed) this.persist();
  }

  trim() {
    if (this.records.size <= this.maxRecords) return;
    const ordered = [...this.records.values()].sort((left, right) => Date.parse(left.updatedAt || 0) - Date.parse(right.updatedAt || 0));
    for (const record of ordered.slice(0, this.records.size - this.maxRecords)) this.records.delete(record.enrichmentId);
  }

  persist() {
    if (!this.persistencePath) return;
    mkdirSync(dirname(this.persistencePath), { recursive: true });
    const temporary = `${this.persistencePath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, records: [...this.records.values()] }), { mode: 0o600 });
    renameSync(temporary, this.persistencePath);
  }

  hydrate() {
    if (!this.persistencePath) return false;
    try {
      const payload = JSON.parse(readFileSync(this.persistencePath, "utf8"));
      if (payload?.version !== 1 || !Array.isArray(payload.records)) return false;
      for (const record of payload.records) {
        if (record?.enrichmentId && ALLOWED_STATUSES.has(record.status)) this.records.set(record.enrichmentId, record);
      }
      this.trim();
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }
}
