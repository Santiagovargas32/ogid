-- Empty derived assessment ledger; historical work is resumed in bounded pages,
-- never scanned during migration/startup. Candle originals remain untouched.
CREATE TABLE candle_validations (
 instrument_id TEXT NOT NULL, interval TEXT NOT NULL, adjustment_mode TEXT NOT NULL,
 dataset_id TEXT NOT NULL, session_key TEXT NOT NULL, candle_revision INTEGER NOT NULL,
 method_version TEXT NOT NULL, eligible INTEGER NOT NULL CHECK(eligible IN (0,1)),
 reason TEXT, checked_at TEXT NOT NULL,
 PRIMARY KEY(instrument_id,interval,adjustment_mode,dataset_id,session_key,candle_revision,method_version)
) STRICT;
CREATE INDEX acquisition_jobs_created ON acquisition_jobs(created_at DESC,job_id DESC);
CREATE INDEX market_datasets_source ON market_datasets(source,dataset_id);
