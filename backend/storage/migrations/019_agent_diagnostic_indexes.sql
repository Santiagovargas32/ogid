-- Bound recent administrative reads and avoid scanning sealed snapshots during
-- an abandoned-build cleanup. Historical rows and migration checksums stay intact.
CREATE INDEX agent_runs_started ON agent_runs(started_at DESC,run_id,job_id);
CREATE INDEX agent_snapshots_building_job
 ON agent_snapshots(json_extract(manifest_json,'$.building.jobId'),as_of,snapshot_id)
 WHERE json_extract(manifest_json,'$.sealed')=0;
