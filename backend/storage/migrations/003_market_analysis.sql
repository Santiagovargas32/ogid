CREATE TABLE market_datasets (
  dataset_id TEXT PRIMARY KEY, source TEXT NOT NULL, adjustment_mode TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json))
) STRICT;
CREATE TABLE candles (
  instrument_id TEXT NOT NULL REFERENCES instruments(instrument_id), interval TEXT NOT NULL,
  adjustment_mode TEXT NOT NULL, dataset_id TEXT NOT NULL REFERENCES market_datasets(dataset_id),
  session_key TEXT NOT NULL, open_time TEXT NOT NULL, close_time TEXT NOT NULL,
  open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
  volume REAL, revision INTEGER NOT NULL CHECK(revision>=1), fetched_at TEXT NOT NULL,
  provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)),
  PRIMARY KEY(instrument_id,interval,adjustment_mode,dataset_id,session_key)
) STRICT;
CREATE INDEX candles_by_time ON candles(instrument_id,interval,adjustment_mode,dataset_id,open_time DESC);
CREATE TABLE candle_revisions (
  instrument_id TEXT NOT NULL, interval TEXT NOT NULL, adjustment_mode TEXT NOT NULL,
  dataset_id TEXT NOT NULL, session_key TEXT NOT NULL, revision INTEGER NOT NULL,
  observed_at TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  PRIMARY KEY(instrument_id,interval,adjustment_mode,dataset_id,session_key,revision),
  FOREIGN KEY(instrument_id,interval,adjustment_mode,dataset_id,session_key)
    REFERENCES candles(instrument_id,interval,adjustment_mode,dataset_id,session_key)
) STRICT;
CREATE TABLE quote_observations (
  observation_id TEXT PRIMARY KEY, instrument_id TEXT NOT NULL REFERENCES instruments(instrument_id),
  market_time TEXT, received_at TEXT NOT NULL, source TEXT NOT NULL, quality TEXT NOT NULL,
  price REAL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
) STRICT;
CREATE INDEX quotes_by_time ON quote_observations(instrument_id,received_at DESC,observation_id);
CREATE TABLE analysis_runs (
  analysis_id TEXT PRIMARY KEY, kind TEXT NOT NULL, method_version TEXT NOT NULL,
  generated_at TEXT NOT NULL, inputs_as_of TEXT NOT NULL, input_hash TEXT NOT NULL,
  quality TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
) STRICT;
CREATE TABLE indicator_values (
  analysis_id TEXT NOT NULL REFERENCES analysis_runs(analysis_id),
  instrument_id TEXT NOT NULL REFERENCES instruments(instrument_id), interval TEXT NOT NULL,
  adjustment_mode TEXT NOT NULL, dataset_id TEXT NOT NULL REFERENCES market_datasets(dataset_id),
  candle_revision_hash TEXT NOT NULL, name TEXT NOT NULL, value REAL,
  PRIMARY KEY(analysis_id,instrument_id,name)
) STRICT;
CREATE INDEX indicator_values_by_instrument ON indicator_values(instrument_id,interval,analysis_id);
CREATE TABLE signal_buckets (
  bucket TEXT NOT NULL, signal TEXT NOT NULL, country TEXT NOT NULL,
  observed_at TEXT NOT NULL, value REAL,
  PRIMARY KEY(signal,country,bucket)
) STRICT;
CREATE TABLE ai_enrichments (
  enrichment_id TEXT PRIMARY KEY, kind TEXT NOT NULL, input_hash TEXT NOT NULL,
  status TEXT NOT NULL, observed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
) STRICT;
CREATE INDEX ai_by_kind ON ai_enrichments(kind,status,observed_at DESC);
