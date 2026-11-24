CREATE TABLE research_awareness_inputs (
  job_id TEXT NOT NULL REFERENCES acquisition_jobs(job_id),
  page INTEGER NOT NULL CHECK (page >= 0),
  items_json TEXT NOT NULL CHECK (json_valid(items_json)),
  PRIMARY KEY (job_id, page)
) STRICT, WITHOUT ROWID;
