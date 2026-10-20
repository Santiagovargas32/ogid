import { AwarenessStore, AWARENESS_RETENTION_MS } from "../services/awareness/awarenessStore.js";
import { readMeta, writeMeta, sourceRow } from "./sqlRepositories.js";
import { parseAwarenessSource } from "../services/awareness/awarenessParsers.js";

// Build a bounded startup projection without sorting/parsing historical JSON.
// Upcoming events retain priority over more recently received releases.
export function loadAwarenessProjection(db,{now=Date.now(),limit=1000}={}) {
  return db.transaction(()=>{
    const upcoming=db.prepare("SELECT event_id FROM awareness_events WHERE json_extract(payload_json,'$.status') IN ('scheduled','live') AND json_extract(payload_json,'$.scheduledAt')>=? ORDER BY observed_at DESC,event_id LIMIT ?").all(new Date(now).toISOString(),limit);
    const recent=upcoming.length<limit?db.prepare("SELECT event_id FROM awareness_events ORDER BY observed_at DESC,event_id LIMIT ?").all(limit):[];
    const ids=[...new Set([...upcoming,...recent].map(row=>row.event_id))].slice(0,limit);
    const event=db.prepare("SELECT payload_json FROM awareness_events WHERE event_id=?");
    return {
      revision:readMeta(db,"awareness.revision",0),
      events:ids.map(id=>JSON.parse(event.get(id).payload_json)),
      sourceStatus:db.prepare("SELECT payload_json FROM awareness_source_status").all().map(row=>JSON.parse(row.payload_json)),
      polls:db.prepare("SELECT source_id,diagnostics_json AS payload_json FROM source_polls WHERE completed_at>=? ORDER BY completed_at").all(new Date(now-7*86400000).toISOString()).map(row=>{const value=JSON.parse(row.payload_json);return {sourceId:row.source_id,poll:value.poll || value};})
    };
  }).deferred();
}

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

  refreshMetadata({includePolls=false} = {}) {
    this.revision = readMeta(this.db, "awareness.revision", 0);
    this.sourceStatuses = new Map(this.db.prepare("SELECT source_id,payload_json FROM awareness_source_status").all().map(row => [row.source_id, JSON.parse(row.payload_json)]));
    // Reconciliation/stale transitions use current source metadata only.
    // Loading seven days of poll audits here blocked the writer twice for
    // every stale transition. Full histories remain available to snapshots.
    if(!includePolls)return;
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

  prune() { /* Historical events are preserved; public views remain time-bounded. */ }

  reconcile(events, options = {}) {
    this.refreshMetadata();
    return this.db.transaction(() => {
      const result = super.reconcile(events, options);
      return {...result, sourceStatus:options.sourceId ? this.sourceStatuses.get(options.sourceId) : null};
    }).immediate();
  }

  setSourceStale(sourceId, stale = true) {
    this.refreshMetadata();
    const changed=this.db.prepare(`SELECT event_id FROM awareness_events INDEXED BY awareness_source_freshness WHERE source_id=? AND (coalesce(json_extract(payload_json,'$.provenance.stale'),0)!=? OR ${stale ? "coalesce(json_extract(payload_json,'$.dataMode'),'')!='stale'" : "json_extract(payload_json,'$.dataMode')='stale'"})`).all(sourceId,Number(Boolean(stale)));
    const read=this.db.prepare('SELECT payload_json FROM awareness_events WHERE event_id=?');
    const events = changed.map(row=>JSON.parse(read.get(row.event_id).payload_json))
      .map(event => ({...event, dataMode:stale ? "stale" : "observed", provenance:{...event.provenance, stale:Boolean(stale)}}));
    return this.reconcile(events);
  }

  getSnapshot(options) {
    this.refreshMetadata({includePolls:true});
    return super.getSnapshot(options);
  }
}
