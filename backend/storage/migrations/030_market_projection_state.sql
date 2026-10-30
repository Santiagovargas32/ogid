CREATE TABLE market_projection_state (
  scope_key TEXT PRIMARY KEY,
  instrument_id TEXT NOT NULL REFERENCES instruments(instrument_id),
  interval TEXT NOT NULL,
  adjustment_mode TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  method_version TEXT NOT NULL,
  required_revision INTEGER NOT NULL CHECK(required_revision>0),
  completed_revision INTEGER NOT NULL DEFAULT 0 CHECK(completed_revision>=0 AND completed_revision<=required_revision),
  state TEXT NOT NULL CHECK(state IN ('pending','complete')),
  analysis_id TEXT REFERENCES analysis_runs(analysis_id),
  source_revisions_json TEXT CHECK(source_revisions_json IS NULL OR json_valid(source_revisions_json)),
  source_job_id TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(instrument_id,interval,adjustment_mode,dataset_id,method_version)
) STRICT;
CREATE INDEX market_projection_pending ON market_projection_state(state,updated_at,scope_key);
