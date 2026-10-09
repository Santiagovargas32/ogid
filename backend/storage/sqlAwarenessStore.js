import { AwarenessStore, AWARENESS_RETENTION_MS } from "../services/awareness/awarenessStore.js";
import { readMeta, writeMeta, sourceRow } from "./sqlRepositories.js";
import { parseAwarenessSource } from "../services/awareness/awarenessParsers.js";

// The map interface belongs to the worker. Neither the HTTP process nor a
// persistent in-memory map owns the complete Awareness history.
export class SqlAwarenessStore extends AwarenessStore {
  constructor(db) {
    super();
    this.db = db;
    this.events = {
      get: id => {
        const row = db.prepare("SELECT payload_json FROM awareness_events WHERE event_id=?").get(id);
        return row ? JSON.parse(row.payload_json) : undefined;
      },
      set: (_id, event) => {
        const sourceId = event.source.sourceId;
        sourceRow(db, sourceId, event.source);
        db.prepare("INSERT INTO awareness_events VALUES(?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET observed_at=excluded.observed_at,revision=excluded.revision,payload_json=excluded.payload_json")
          .run(event.eventId, sourceId, event.observedAt, event.revision, JSON.stringify(event));
      },
      values: () => this.values()
    };
    this.refreshMetadata();
  }

  *values() {
    for (const row of this.db.prepare("SELECT payload_json FROM awareness_events").iterate()) yield JSON.parse(row.payload_json);
  }

  parseSource(body, source, options) {
    return parseAwarenessSource(body, source, options);
  }

  refreshMetadata() {
    this.revision = readMeta(this.db, "awareness.revision", 0);
    this.sourceStatuses = new Map(this.db.prepare("SELECT source_id,payload_json FROM awareness_source_status").all().map(row => [row.source_id, JSON.parse(row.payload_json)]));
    this.pollHistories = new Map();
    const cutoff = new Date(this.now() - 7 * 86400000).toISOString();
    for (const row of this.db.prepare("SELECT source_id,diagnostics_json AS payload_json FROM source_polls WHERE completed_at>=? ORDER BY completed_at").iterate(cutoff)) {
      const saved = JSON.parse(row.payload_json), poll = saved.poll || saved;
      if (!this.pollHistories.has(row.source_id)) this.pollHistories.set(row.source_id, []);
      this.pollHistories.get(row.source_id).push(poll);
    }
  }

  persist() {
    if (!this.db) return;
    writeMeta(this.db, "awareness.revision", this.revision);
    for (const status of this.sourceStatuses.values()) {
      sourceRow(this.db, status.sourceId, status);
      this.db.prepare("INSERT INTO awareness_source_status VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET payload_json=excluded.payload_json").run(status.sourceId, JSON.stringify(status));
    }
  }

  appendAudit(event) {
    this.db.prepare("INSERT INTO runtime_audit(kind,observed_at,payload_json) VALUES('awareness-audit',?,?)").run(new Date(this.now()).toISOString(), JSON.stringify({event, revision:this.revision}));
  }

  prune() {
    const cutoff = new Date(this.now() - AWARENESS_RETENTION_MS).toISOString();
    this.db.prepare("DELETE FROM awareness_events WHERE julianday(coalesce(nullif(json_extract(payload_json,'$.publishedAt'),''),nullif(json_extract(payload_json,'$.scheduledAt'),''),nullif(json_extract(payload_json,'$.updatedAt'),''),observed_at))<julianday(?)").run(cutoff);
  }

  reconcile(events, options = {}) {
    this.refreshMetadata();
    return this.db.transaction(() => {
      const result = super.reconcile(events, options);
      return {...result, sourceStatus:options.sourceId ? this.sourceStatuses.get(options.sourceId) : null};
    }).immediate();
  }

  setSourceStale(sourceId, stale = true) {
    this.refreshMetadata();
    const events = this.db.prepare("SELECT payload_json FROM awareness_events WHERE source_id=?").all(sourceId).map(row => JSON.parse(row.payload_json))
      .filter(event => Boolean(event.provenance?.stale) !== Boolean(stale) || (stale ? event.dataMode !== "stale" : event.dataMode === "stale"))
      .map(event => ({...event, dataMode:stale ? "stale" : "observed", provenance:{...event.provenance, stale:Boolean(stale)}}));
    return this.reconcile(events);
  }

  getSnapshot(options) {
    this.refreshMetadata();
    return super.getSnapshot(options);
  }
}
