CREATE TABLE pipeline_definitions (
  pipeline_id TEXT PRIMARY KEY,
  storage_backend TEXT NOT NULL CHECK(storage_backend IN ('legacy-json','sqlite')),
  description TEXT NOT NULL
) STRICT;
INSERT INTO pipeline_definitions VALUES
 ('storage','sqlite','Storage worker lifecycle'),
 ('news','legacy-json','Selected news ingestion'),
 ('rss','legacy-json','RSS corpus and source state'),
 ('awareness','legacy-json','Official events and poll audit'),
 ('market-quotes','legacy-json','Quotes and observations'),
 ('market-candles','legacy-json','Canonical and imported OHLCV'),
 ('research','legacy-json','Events, scenarios, jobs and consumer checkpoints'),
 ('signals','legacy-json','Signal baselines and derived analyses'),
 ('ai','legacy-json','Enrichment, history and budgets');
CREATE TABLE pipeline_runs (
  run_id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL REFERENCES pipeline_definitions(pipeline_id),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('running','healthy','degraded','failed','stopped')),
  counts_json TEXT NOT NULL CHECK(json_valid(counts_json)),
  error_code TEXT
) STRICT;
CREATE INDEX pipeline_runs_by_time ON pipeline_runs(pipeline_id, started_at DESC, run_id);
CREATE TABLE storage_commands (
  request_id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  committed_at TEXT NOT NULL
) STRICT;
CREATE TABLE import_manifests (
  import_id TEXT PRIMARY KEY, source_kind TEXT NOT NULL, source_checksum TEXT NOT NULL,
  source_schema TEXT NOT NULL, status TEXT NOT NULL,
  created_at TEXT NOT NULL, completed_at TEXT, counts_json TEXT NOT NULL CHECK(json_valid(counts_json))
) STRICT;
CREATE TABLE instruments (
  instrument_id TEXT PRIMARY KEY, symbol TEXT NOT NULL, asset_type TEXT NOT NULL,
  currency TEXT, timezone TEXT, metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json))
) STRICT;
CREATE TABLE instrument_aliases (
  instrument_id TEXT NOT NULL REFERENCES instruments(instrument_id),
  provider TEXT NOT NULL, symbol TEXT NOT NULL, valid_from TEXT NOT NULL, valid_to TEXT,
  PRIMARY KEY(instrument_id,provider,symbol,valid_from)
) STRICT;
CREATE TABLE sources (
  source_id TEXT PRIMARY KEY, publisher TEXT, admission_state TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json))
) STRICT;
CREATE TABLE source_states (
  source_id TEXT PRIMARY KEY REFERENCES sources(source_id), updated_at TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK(json_valid(state_json))
) STRICT;
CREATE TABLE acquisition_jobs (
  job_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  job_json TEXT NOT NULL CHECK(json_valid(job_json))
) STRICT;
CREATE INDEX acquisition_jobs_by_status ON acquisition_jobs(status,updated_at);
CREATE TABLE outbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, change_id TEXT NOT NULL UNIQUE,
  entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL, revision INTEGER NOT NULL,
  observed_at TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
) STRICT;
CREATE TABLE consumer_checkpoints (
  consumer_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL CHECK(sequence>=0),
  acknowledged_at TEXT NOT NULL
) STRICT;
