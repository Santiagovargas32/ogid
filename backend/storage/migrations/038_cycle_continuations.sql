-- Continuations share the acquisition ledger and the existing business writer.
CREATE UNIQUE INDEX cycle_continuation_active_scope ON acquisition_jobs(json_extract(job_json,'$.scope'))
 WHERE kind='cycle-continuation-v1' AND status='pending';
CREATE INDEX cycle_continuation_pending ON acquisition_jobs(kind,status,job_id);
