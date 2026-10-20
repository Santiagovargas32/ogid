CREATE TABLE agent_devices (
 device_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, csrf TEXT NOT NULL,
 label TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT
) STRICT;
CREATE TABLE agent_sessions (
 session_id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES agent_devices(device_id),
 model TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, opencode_id TEXT UNIQUE
) STRICT;
CREATE INDEX agent_sessions_owner ON agent_sessions(device_id,created_at DESC);
CREATE TABLE agent_messages (
 message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(session_id),
 role TEXT NOT NULL CHECK(role IN ('user','assistant','tool')), created_at TEXT NOT NULL,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), idempotency_key TEXT,
 UNIQUE(session_id,idempotency_key)
) STRICT;
CREATE INDEX agent_messages_page ON agent_messages(session_id,created_at,message_id);
CREATE TABLE agent_snapshots (
 snapshot_id TEXT PRIMARY KEY, as_of TEXT NOT NULL, scope TEXT NOT NULL,
 manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json))
) STRICT;
CREATE TABLE agent_evidence (
 sequence INTEGER PRIMARY KEY, snapshot_id TEXT NOT NULL REFERENCES agent_snapshots(snapshot_id),
 evidence_id TEXT NOT NULL, domain TEXT NOT NULL, available_at TEXT NOT NULL,
 article_id TEXT, article_revision INTEGER, payload_json TEXT CHECK(payload_json IS NULL OR json_valid(payload_json)),
 FOREIGN KEY(article_id,article_revision) REFERENCES article_revisions(article_id,revision),
 UNIQUE(snapshot_id,evidence_id)
) STRICT;
CREATE INDEX agent_evidence_page ON agent_evidence(snapshot_id,sequence);
CREATE TABLE article_permitted_excerpts (
 article_id TEXT NOT NULL, revision INTEGER NOT NULL, sha256 TEXT NOT NULL,
 excerpt TEXT NOT NULL, available_at TEXT NOT NULL,
 PRIMARY KEY(article_id,revision),
 FOREIGN KEY(article_id,revision) REFERENCES article_revisions(article_id,revision)
) STRICT;
CREATE TABLE agent_clusters (
 snapshot_id TEXT NOT NULL REFERENCES agent_snapshots(snapshot_id), cluster_id TEXT NOT NULL,
 rank INTEGER NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 PRIMARY KEY(snapshot_id,cluster_id), UNIQUE(snapshot_id,rank)
) STRICT;
CREATE TABLE agent_cluster_members (
 snapshot_id TEXT NOT NULL, cluster_id TEXT NOT NULL, evidence_id TEXT NOT NULL,
 PRIMARY KEY(snapshot_id,cluster_id,evidence_id),
 FOREIGN KEY(snapshot_id,cluster_id) REFERENCES agent_clusters(snapshot_id,cluster_id),
 FOREIGN KEY(snapshot_id,evidence_id) REFERENCES agent_evidence(snapshot_id,evidence_id)
) STRICT;
CREATE TABLE agent_jobs (
 job_id TEXT PRIMARY KEY, task TEXT NOT NULL, scope TEXT NOT NULL, model TEXT NOT NULL,
 prompt_version TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
 snapshot_id TEXT REFERENCES agent_snapshots(snapshot_id), session_id TEXT REFERENCES agent_sessions(session_id),
 status TEXT NOT NULL CHECK(status IN ('queued','waiting-model','running','validating','completed','failed','cancelled','superseded','incomplete')),
 priority INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 lease_owner TEXT, lease_until INTEGER, fence INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
 error_code TEXT, opencode_id TEXT, message_id TEXT, input_json TEXT NOT NULL CHECK(json_valid(input_json))
) STRICT;
CREATE INDEX agent_jobs_claim ON agent_jobs(status,priority,created_at);
CREATE TABLE agent_runs (
 run_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES agent_jobs(job_id), fence INTEGER NOT NULL,
 started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL,
 metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)), UNIQUE(job_id,fence)
) STRICT;
CREATE TABLE agent_publications (
 publication_id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE REFERENCES agent_jobs(job_id),
 snapshot_id TEXT NOT NULL REFERENCES agent_snapshots(snapshot_id), task TEXT NOT NULL, scope TEXT NOT NULL,
 published_at TEXT NOT NULL, valid_until TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('shadow','visible')),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
) STRICT;
CREATE INDEX agent_publications_latest ON agent_publications(task,scope,published_at DESC);
CREATE TABLE agent_memory (
 scope TEXT NOT NULL, publication_id TEXT NOT NULL REFERENCES agent_publications(publication_id),
 created_at TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 PRIMARY KEY(scope,publication_id)
) STRICT;
CREATE TABLE geopolitical_alerts (
 alert_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, source_id TEXT NOT NULL,
 updated_at TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
) STRICT;
CREATE INDEX geopolitical_alerts_page ON geopolitical_alerts(updated_at DESC,alert_id);
CREATE TABLE geopolitical_alert_revisions (
 alert_id TEXT NOT NULL REFERENCES geopolitical_alerts(alert_id), revision INTEGER NOT NULL,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), PRIMARY KEY(alert_id,revision)
) STRICT;
CREATE TABLE geopolitical_alert_state (
 device_id TEXT NOT NULL REFERENCES agent_devices(device_id), alert_id TEXT NOT NULL REFERENCES geopolitical_alerts(alert_id),
 read_revision INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
 PRIMARY KEY(device_id,alert_id)
) STRICT;
-- Domain changes and their journal entries share the originating transaction.
CREATE TRIGGER agent_article_change AFTER INSERT ON article_revisions BEGIN
 INSERT OR IGNORE INTO outbox(change_id,entity_kind,entity_id,revision,observed_at,payload_json)
 VALUES('agent:article:'||new.article_id||':'||new.revision,'article-revision',new.article_id,new.revision,new.observed_at,json_object('domain','news'));
END;
CREATE TRIGGER agent_candle_change AFTER INSERT ON candle_revisions BEGIN
 INSERT OR IGNORE INTO outbox(change_id,entity_kind,entity_id,revision,observed_at,payload_json)
 VALUES('agent:candle:'||new.instrument_id||':'||new.interval||':'||new.dataset_id||':'||new.session_key||':'||new.adjustment_mode||':'||new.revision,'candle-revision',new.instrument_id,new.revision,new.observed_at,json_object('domain','technical','interval',new.interval));
END;
CREATE TRIGGER agent_awareness_insert AFTER INSERT ON awareness_events BEGIN
 INSERT OR IGNORE INTO outbox(change_id,entity_kind,entity_id,revision,observed_at,payload_json)
 VALUES('agent:awareness:'||new.event_id||':'||new.revision,'official-revision',new.event_id,new.revision,new.observed_at,json_object('domain','awareness'));
END;
CREATE TRIGGER agent_awareness_update AFTER UPDATE OF revision ON awareness_events WHEN new.revision!=old.revision BEGIN
 INSERT OR IGNORE INTO outbox(change_id,entity_kind,entity_id,revision,observed_at,payload_json)
 VALUES('agent:awareness:'||new.event_id||':'||new.revision,'official-revision',new.event_id,new.revision,new.observed_at,json_object('domain','awareness'));
END;
CREATE TRIGGER agent_coverage_update AFTER UPDATE ON awareness_source_status WHEN json_extract(new.payload_json,'$.status') IS NOT json_extract(old.payload_json,'$.status') OR json_extract(new.payload_json,'$.stale') IS NOT json_extract(old.payload_json,'$.stale') BEGIN
 INSERT OR IGNORE INTO outbox(change_id,entity_kind,entity_id,revision,observed_at,payload_json)
 VALUES('agent:coverage:'||new.source_id||':'||hex(randomblob(16)),'coverage-revision',new.source_id,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),json_object('domain','coverage'));
END;

CREATE TRIGGER agent_analysis_change AFTER INSERT ON analysis_runs WHEN new.kind IN ('technical.get','conditions.getSnapshot','advanced.getSnapshot') BEGIN
 INSERT OR IGNORE INTO outbox(change_id,entity_kind,entity_id,revision,observed_at,payload_json)
 VALUES('agent:analysis:'||new.analysis_id,'analysis-revision',new.kind,1,new.generated_at,json_object('domain','analysis'));
END;
CREATE TRIGGER agent_fundamentals_change AFTER UPDATE OF payload_json ON research_rows WHEN new.collection='companyFacts' AND new.payload_json!=old.payload_json BEGIN
 INSERT INTO outbox(change_id,entity_kind,entity_id,revision,observed_at,payload_json)
 VALUES('agent:fundamentals:'||new.entity_id||':'||hex(randomblob(16)),'fundamentals-revision',new.entity_id,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),json_object('domain','fundamentals'));
END;

CREATE TRIGGER agent_fundamentals_insert AFTER INSERT ON research_rows WHEN new.collection='companyFacts' BEGIN
 INSERT INTO outbox(change_id,entity_kind,entity_id,revision,observed_at,payload_json)
 VALUES('agent:fundamentals:'||new.entity_id||':'||hex(randomblob(16)),'fundamentals-revision',new.entity_id,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),json_object('domain','fundamentals'));
END;
