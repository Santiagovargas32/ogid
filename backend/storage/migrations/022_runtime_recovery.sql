-- Metadata-only lookups precede loading event payload pages.
CREATE INDEX events_identity_time ON events(event_id,observed_at DESC);
CREATE INDEX acquisition_jobs_kind_status ON acquisition_jobs(kind,status,updated_at,job_id);
-- Existing publications and completed jobs remain immutable.
ALTER TABLE analysis_jobs ADD COLUMN owner TEXT;
ALTER TABLE analysis_jobs ADD COLUMN fence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE analysis_jobs ADD COLUMN lease_until INTEGER;
