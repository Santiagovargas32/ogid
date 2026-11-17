-- Frozen, ordered inputs retained until the writer confirms their page.
CREATE TABLE financial_continuation_inputs (
  job_id TEXT NOT NULL REFERENCES acquisition_jobs(job_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  item_json TEXT NOT NULL CHECK (json_valid(item_json)),
  PRIMARY KEY (job_id, ordinal)
) STRICT, WITHOUT ROWID;
