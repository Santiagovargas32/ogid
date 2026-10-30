-- Exact source dependencies are committed atomically with shadow publications.
CREATE TABLE situation_analysis_dependencies (
 publication_id TEXT NOT NULL REFERENCES agent_publications(publication_id),
 evidence_id TEXT NOT NULL, stream TEXT NOT NULL, source_id TEXT NOT NULL,
 source_revision INTEGER NOT NULL, source_sequence INTEGER NOT NULL,
 PRIMARY KEY(publication_id,evidence_id)
) STRICT;
CREATE INDEX situation_analysis_source ON situation_analysis_dependencies(stream,source_id,source_sequence);
CREATE TABLE situation_analysis_requests (
 request_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL,
 job_id TEXT NOT NULL REFERENCES agent_jobs(job_id)
) STRICT;
