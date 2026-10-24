// Fixed queries only: no corpus is returned and no SQL is supplied by clients.
export function readDatabaseDiagnostics(db, { includeResearchBytes = false } = {}) {
  return db.transaction(() => ({
    sampledAt:new Date().toISOString(),
    // Periodic telemetry must not scan every historical JSON payload.
    // Exact payload sizes are available to an explicit one-off inspection.
    researchBytesSampled:includeResearchBytes,
    researchTables:db.prepare(includeResearchBytes
      ? "SELECT collection,count(*) AS records,sum(length(CAST(payload_json AS BLOB))) AS bytes FROM research_rows GROUP BY collection"
      : "SELECT collection,records,NULL AS bytes FROM storage_collection_counts WHERE records>0 ORDER BY collection").all(),
    counts:Object.fromEntries(db.prepare("SELECT name,records FROM storage_counts ORDER BY name").all().map(row=>[row.name,row.records])),
    marketPersistence:db.prepare("SELECT count(*) AS pending,min(updated_at) AS oldestPendingAt FROM acquisition_jobs WHERE kind='market-persistence' AND status='pending'").get(),
    checkpoints:db.prepare("SELECT pipeline_id AS pipelineId,updated_at AS updatedAt,revision,payload_json FROM pipeline_checkpoints ORDER BY pipeline_id").all().map(({payload_json,...row})=>({...row,...JSON.parse(payload_json)})),
    analysisJobs:db.prepare("SELECT job_id AS jobId,status,as_of AS inputsAsOf,updated_at AS updatedAt,attempts,error_code AS errorCode FROM analysis_jobs WHERE status IN ('queued','running') ORDER BY created_at LIMIT 64").all(),
    pipelines:db.prepare("SELECT d.pipeline_id AS pipelineId,d.storage_backend AS storageBackend,r.started_at AS startedAt,r.completed_at AS completedAt,r.status,r.error_code AS errorCode,c.updated_at AS lastPersistedAt FROM pipeline_definitions d LEFT JOIN pipeline_checkpoints c ON c.pipeline_id=d.pipeline_id LEFT JOIN pipeline_runs r ON r.run_id=(SELECT run_id FROM pipeline_runs WHERE pipeline_id=d.pipeline_id ORDER BY started_at DESC LIMIT 1) ORDER BY d.pipeline_id").all()
  })).deferred();
}
