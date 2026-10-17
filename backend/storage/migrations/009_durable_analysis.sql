CREATE TABLE analysis_jobs (
  job_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, calculation_key TEXT NOT NULL UNIQUE,
  method_version TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','complete','failed')),
  as_of TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, error_code TEXT,
  input_json TEXT NOT NULL CHECK(json_valid(input_json)), analysis_id TEXT REFERENCES analysis_runs(analysis_id)
) STRICT;
CREATE INDEX analysis_jobs_pending ON analysis_jobs(status,created_at);
CREATE INDEX analysis_jobs_scope ON analysis_jobs(scope_key,created_at DESC);
CREATE UNIQUE INDEX analysis_jobs_active_scope ON analysis_jobs(scope_key) WHERE status IN ('queued','running');
CREATE TABLE analysis_latest (
  scope_key TEXT PRIMARY KEY, analysis_id TEXT NOT NULL REFERENCES analysis_runs(analysis_id),
  as_of TEXT NOT NULL, calculation_key TEXT NOT NULL
) STRICT;
CREATE INDEX article_revisions_available ON article_revisions(article_id,observed_at DESC,revision DESC);
CREATE INDEX signal_changes_time ON signal_changes(generated_at,sequence);
CREATE INDEX analysis_runs_kind_time ON analysis_runs(kind,generated_at DESC);
CREATE TABLE derived_observations (
  kind TEXT NOT NULL, input_hash TEXT NOT NULL, observed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), PRIMARY KEY(kind,input_hash)
) STRICT;

CREATE INDEX derived_observations_by_time ON derived_observations(kind,observed_at DESC);
CREATE TABLE storage_writer_owner (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), token TEXT NOT NULL,
  process_id INTEGER NOT NULL, acquired_at TEXT NOT NULL
) STRICT;

CREATE INDEX signal_changes_instrument_sequence ON signal_changes(json_extract(payload_json,'$.instrumentId'),sequence);

CREATE INDEX article_revisions_publication ON article_revisions(json_extract(payload_json,'$.publishedAt'),article_id,revision);

-- Input descriptors are immutable alongside their result, never reconstructed
-- from the current HTTP context when a cached result is served.
CREATE TABLE analysis_inputs (
  analysis_id TEXT PRIMARY KEY REFERENCES analysis_runs(analysis_id),
  parameters_json TEXT NOT NULL CHECK(json_valid(parameters_json)),
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json))
) STRICT;
