import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AppError } from "../../utils/error.js";
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class MaterialAlertStore {
  constructor({ persistencePath = null, now = Date.now, retentionDays = 30, maxEntries = 10000 } = {}) {
    this.path = persistencePath; this.now = now; this.retentionDays = retentionDays; this.maxEntries = maxEntries; this.observed = new Map(); this.acknowledged = new Map();
    if (this.path) try {
      const value = JSON.parse(readFileSync(this.path, "utf8"));
      if (value.schemaVersion !== "material-alerts-v1") throw new Error();
      this.observed = new Map(value.observed || []); this.acknowledged = new Map(value.acknowledged || []);
    } catch (error) { if (error.code !== "ENOENT") throw new AppError("No se pudo recuperar el estado de alertas; no sobrescribirlo.", 503, "ALERT_RECOVERY_FAILED"); }
    this.prune();
  }
  prune() {
    const cutoff = this.now() - this.retentionDays * 86400000;
    for (const map of [this.observed, this.acknowledged]) {
      for (const [id, row] of map) if (Date.parse(row.observedAt || row.deliveredAt) < cutoff) map.delete(id);
      while (map.size > this.maxEntries) map.delete(map.keys().next().value);
    }
  }
  persist() {
    this.prune(); if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ schemaVersion: "material-alerts-v1", observed: [...this.observed], acknowledged: [...this.acknowledged] }), { mode: 0o600 }); renameSync(temporary, this.path);
  }
  candidates(evidence = []) {
    this.prune(); const unique = new Map();
    for (const item of evidence) {
      // El mismo titular reproducido por feeds no es un hecho nuevo ni otra corroboración.
      const evidenceId = item.eventId || item.id;
      const earlierVersion = [...this.observed.values()].find(row => row.evidenceIds.includes(evidenceId));
      const factKey = earlierVersion?.factKey || hash([String(item.title || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(), (item.publishedAt || item.scheduledAt || item.receivedAt || "").slice(0, 10)]);
      const semanticRevision = hash([item.title, item.summary || item.excerpt || null, item.status || null, item.importance || null]);
      const candidateId = `alert-${hash([factKey, semanticRevision]).slice(0, 40)}`;
      const earlier = unique.get(factKey);
      if (earlier) { earlier.evidenceIds.push(item.eventId || item.id); continue; }
      const acknowledged = this.acknowledged.get(factKey);
      const row = { candidateId, factKey, semanticRevision, title: item.title, evidenceIds: [...new Set([...(this.observed.get(candidateId)?.evidenceIds || []), evidenceId])].slice(0, 100), sourceRevision: item.revision ?? null,
        status: item.status || null, observedAt: new Date(this.now()).toISOString(), correction: Boolean(acknowledged && acknowledged.semanticRevision !== semanticRevision),
        materiality: item.materiality, claimStatus: item.claimStatus || "report-not-independently-corroborated", delivered: false };
      this.observed.set(candidateId, row);
      if (!acknowledged || acknowledged.semanticRevision !== semanticRevision) unique.set(factKey, row);
    }
    this.persist(); return [...unique.values()];
  }
  acknowledge({ candidateIds, deliveredAt }) {
    this.prune();
    if (Date.parse(deliveredAt) > this.now() + 60000) throw new AppError("No se puede reconocer una entrega futura.", 400, "INVALID_DELIVERY_TIME");
    const rows = candidateIds.map(id => this.observed.get(id));
    if (rows.some(row => !row)) throw new AppError("Solo se pueden reconocer candidatos observados y vigentes.", 400, "UNKNOWN_ALERT_CANDIDATE");
    for (const row of rows) this.acknowledged.set(row.factKey, { semanticRevision: row.semanticRevision, candidateId: row.candidateId, deliveredAt });
    this.persist(); return { acknowledged: rows.length, deliveredAt };
  }
}
