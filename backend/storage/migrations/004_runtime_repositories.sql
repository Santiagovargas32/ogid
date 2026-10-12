CREATE TABLE runtime_meta (key TEXT PRIMARY KEY, value_json TEXT NOT NULL CHECK(json_valid(value_json))) STRICT;
CREATE TABLE research_rows (
  collection TEXT NOT NULL, entity_id TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  PRIMARY KEY(collection,entity_id)
) STRICT;
CREATE TABLE alert_rows (
  collection TEXT NOT NULL, entity_id TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  PRIMARY KEY(collection,entity_id)
) STRICT;
CREATE TABLE signal_changes (sequence INTEGER PRIMARY KEY, generated_at TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json))) STRICT;
CREATE TABLE article_aliases (alias TEXT NOT NULL, article_id TEXT NOT NULL REFERENCES articles(article_id), PRIMARY KEY(alias,article_id)) STRICT;
ALTER TABLE article_instruments ADD COLUMN match_json TEXT;
CREATE INDEX articles_by_last_seen ON articles(last_seen_at);
ALTER TABLE candles ADD COLUMN payload_json TEXT CHECK(payload_json IS NULL OR json_valid(payload_json));
CREATE TABLE news_query_snapshots (
  snapshot_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, filter_hash TEXT NOT NULL,
  revision INTEGER NOT NULL, coverage_json TEXT NOT NULL, total INTEGER NOT NULL,
  synthetic_count INTEGER NOT NULL, stale_count INTEGER NOT NULL
) STRICT;
CREATE TABLE news_query_items (
  snapshot_id TEXT NOT NULL REFERENCES news_query_snapshots(snapshot_id) ON DELETE CASCADE,
  position INTEGER NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  PRIMARY KEY(snapshot_id,position)
) STRICT;
CREATE TABLE runtime_snapshots (kind TEXT PRIMARY KEY, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json))) STRICT;
CREATE TABLE runtime_audit (sequence INTEGER PRIMARY KEY, kind TEXT NOT NULL, observed_at TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json))) STRICT;
CREATE INDEX runtime_audit_by_time ON runtime_audit(kind,observed_at);
