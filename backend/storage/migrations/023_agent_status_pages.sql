-- Status reads select at most 50 rows from each ordered partial index before
-- loading payload metadata. Preserve active-first order without a corpus sort.
CREATE INDEX agent_jobs_active_recent ON agent_jobs(updated_at DESC,job_id)
 WHERE status IN ('running','waiting-model','validating');
CREATE INDEX agent_jobs_inactive_recent ON agent_jobs(updated_at DESC,job_id)
 WHERE status NOT IN ('running','waiting-model','validating');
