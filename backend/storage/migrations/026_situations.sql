-- Durable revision streams and deterministic consumers. No historical payload scan.
CREATE TABLE awareness_revisions (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 event_id TEXT NOT NULL, revision INTEGER NOT NULL,
 source_id TEXT NOT NULL, available_at TEXT NOT NULL,
 baseline INTEGER NOT NULL CHECK(baseline IN (0,1)),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 UNIQUE(event_id,revision)
) STRICT;
CREATE INDEX awareness_revision_source ON awareness_revisions(event_id,sequence);
CREATE TRIGGER awareness_revision_insert AFTER INSERT ON awareness_events BEGIN
 INSERT INTO awareness_revisions(event_id,revision,source_id,available_at,baseline,payload_json)
 VALUES(new.event_id,new.revision,new.source_id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),0,new.payload_json);
END;
CREATE TRIGGER awareness_revision_update AFTER UPDATE ON awareness_events
 WHEN new.revision!=old.revision OR new.payload_json!=old.payload_json BEGIN
 SELECT CASE WHEN new.revision<=old.revision THEN RAISE(ABORT,'AWARENESS_REVISION_NOT_MONOTONIC') END;
 INSERT OR IGNORE INTO awareness_revisions(event_id,revision,source_id,available_at,baseline,payload_json)
 VALUES(old.event_id,old.revision,old.source_id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,old.payload_json);
 INSERT INTO awareness_revisions(event_id,revision,source_id,available_at,baseline,payload_json)
 VALUES(new.event_id,new.revision,new.source_id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),0,new.payload_json);
END;
CREATE TABLE situation_bootstrap (
 phase TEXT PRIMARY KEY, cursor INTEGER NOT NULL DEFAULT 0,
 upper_rowid INTEGER NOT NULL, part INTEGER NOT NULL DEFAULT 0,
 complete INTEGER NOT NULL DEFAULT 0, error_code TEXT
) STRICT;
INSERT INTO situation_bootstrap(phase,upper_rowid,complete)
 SELECT 'legacy',coalesce(max(rowid),0),CASE WHEN count(*)=0 THEN 1 ELSE 0 END FROM geopolitical_alert_revisions;
INSERT INTO situation_bootstrap(phase,upper_rowid,complete)
 SELECT 'awareness',coalesce(max(rowid),0),CASE WHEN count(*)=0 THEN 1 ELSE 0 END FROM awareness_events;
CREATE TABLE situation_consumers (
 stream TEXT PRIMARY KEY CHECK(stream IN ('news','awareness')),
 last_sequence INTEGER NOT NULL DEFAULT 0, upper_sequence INTEGER NOT NULL DEFAULT 0,
 bootstrap_upper INTEGER NOT NULL, processed INTEGER NOT NULL DEFAULT 0,
 excluded INTEGER NOT NULL DEFAULT 0, continuation_json TEXT,
 updated_at TEXT, error_code TEXT, blocked_sequence INTEGER
) STRICT;
INSERT INTO situation_consumers(stream,bootstrap_upper) SELECT 'news',coalesce(max(sequence),0) FROM news_comparison_changes;
INSERT INTO situation_consumers(stream,bootstrap_upper) VALUES('awareness',0);
CREATE TABLE situation_entities (
 entity_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('situation','incident')),
 revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE situation_contexts (context_key TEXT PRIMARY KEY, entity_id TEXT NOT NULL REFERENCES situation_entities(entity_id)) STRICT;
CREATE TABLE situation_revisions (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, entity_id TEXT NOT NULL REFERENCES situation_entities(entity_id),
 revision INTEGER NOT NULL, kind TEXT NOT NULL, event_key TEXT NOT NULL UNIQUE,
 changed_at TEXT NOT NULL, occurred_at TEXT, published_at TEXT,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), UNIQUE(entity_id,revision)
) STRICT;
CREATE INDEX situation_revision_entity ON situation_revisions(entity_id,sequence DESC);
CREATE INDEX situation_revision_kind ON situation_revisions(kind,sequence DESC);
CREATE TABLE situation_members (
 stream TEXT NOT NULL, source_id TEXT NOT NULL, entity_id TEXT NOT NULL REFERENCES situation_entities(entity_id),
 source_revision INTEGER NOT NULL, source_sequence INTEGER NOT NULL,
 PRIMARY KEY(stream,source_id)
) STRICT;
CREATE INDEX situation_member_entity ON situation_members(entity_id,stream,source_id);
CREATE TABLE situation_evidence (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, entity_id TEXT NOT NULL REFERENCES situation_entities(entity_id),
 domain_sequence INTEGER NOT NULL REFERENCES situation_revisions(sequence),
 stream TEXT NOT NULL, source_id TEXT NOT NULL, source_revision INTEGER NOT NULL,
 source_sequence INTEGER NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 UNIQUE(entity_id,domain_sequence,stream,source_id)
) STRICT;
CREATE INDEX situation_evidence_entity ON situation_evidence(entity_id,domain_sequence DESC,sequence DESC);
CREATE INDEX situation_evidence_source ON situation_evidence(entity_id,stream,source_id,domain_sequence DESC);
CREATE TABLE situation_incident_links (
 incident_id TEXT NOT NULL REFERENCES situation_entities(entity_id), situation_id TEXT NOT NULL REFERENCES situation_entities(entity_id),
 PRIMARY KEY(incident_id,situation_id)
) STRICT;
CREATE TABLE situation_incident_refs (
 incident_id TEXT NOT NULL REFERENCES situation_entities(entity_id), stream TEXT NOT NULL, source_id TEXT NOT NULL,
 source_revision INTEGER NOT NULL, source_sequence INTEGER NOT NULL,
 PRIMARY KEY(incident_id,stream,source_id)
) STRICT;
CREATE INDEX situation_incident_source ON situation_incident_refs(stream,source_id,incident_id);
CREATE TABLE situation_invalidations (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, stream TEXT NOT NULL, source_id TEXT NOT NULL,
 source_sequence INTEGER NOT NULL, domain_sequence INTEGER NOT NULL,
 reason TEXT NOT NULL, changed_at TEXT NOT NULL,
 UNIQUE(stream,source_sequence,source_id)
) STRICT;
CREATE INDEX situation_invalidation_source ON situation_invalidations(stream,source_id,source_sequence);
CREATE TABLE situation_outbox (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, emission_key TEXT NOT NULL UNIQUE,
 entity_id TEXT NOT NULL REFERENCES situation_entities(entity_id), domain_sequence INTEGER NOT NULL REFERENCES situation_revisions(sequence),
 change_kind TEXT NOT NULL, historical INTEGER NOT NULL CHECK(historical IN (0,1)), available_at TEXT NOT NULL,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
) STRICT;
CREATE TABLE situation_legacy_links (
 stream TEXT NOT NULL, source_id TEXT NOT NULL, alert_id TEXT NOT NULL REFERENCES geopolitical_alerts(alert_id),
 PRIMARY KEY(stream,source_id)
) STRICT;
CREATE TABLE geopolitical_alert_changes (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, alert_id TEXT NOT NULL, revision INTEGER NOT NULL,
 UNIQUE(alert_id,revision)
) STRICT;
CREATE INDEX geopolitical_alert_change_entity ON geopolitical_alert_changes(alert_id,sequence DESC);
CREATE TRIGGER geopolitical_alert_revision_journal AFTER INSERT ON geopolitical_alert_revisions BEGIN
 INSERT OR IGNORE INTO geopolitical_alert_changes(alert_id,revision) VALUES(new.alert_id,new.revision);
END;
CREATE TABLE situation_requests (request_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, result_json TEXT NOT NULL CHECK(json_valid(result_json))) STRICT;
