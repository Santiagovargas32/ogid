CREATE TABLE awareness_events (
  event_id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(source_id),
  observed_at TEXT NOT NULL, revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
) STRICT;
CREATE INDEX awareness_by_time ON awareness_events(observed_at DESC,event_id);
CREATE TABLE awareness_source_status (
  source_id TEXT PRIMARY KEY REFERENCES sources(source_id),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
) STRICT;
CREATE TABLE pipeline_checkpoints (
  pipeline_id TEXT PRIMARY KEY REFERENCES pipeline_definitions(pipeline_id),
  updated_at TEXT NOT NULL, revision TEXT, payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
) STRICT;
