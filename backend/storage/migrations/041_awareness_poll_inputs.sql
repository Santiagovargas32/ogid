-- Parsed source results await bounded reconciliation after a confirmed response.
CREATE TABLE awareness_poll_inputs (
  job_id TEXT NOT NULL REFERENCES acquisition_jobs(job_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  PRIMARY KEY(job_id,ordinal)
) STRICT, WITHOUT ROWID;
