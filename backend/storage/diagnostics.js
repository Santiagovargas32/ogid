// Fixed queries only: no corpus is returned and no SQL is supplied by clients.
export function readDatabaseDiagnostics(db) {
  return db.transaction(() => ({
    sampledAt:new Date().toISOString(),
    counts:Object.fromEntries(["articles","article_revisions","events","candles","candle_revisions","quote_observations","signal_buckets","awareness_events","source_polls","ai_enrichments","acquisition_jobs","analysis_runs"].map(table=>[table,db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n])),
    checkpoints:db.prepare("SELECT pipeline_id AS pipelineId,updated_at AS updatedAt,revision,payload_json FROM pipeline_checkpoints ORDER BY pipeline_id").all().map(({payload_json,...row})=>({...row,...JSON.parse(payload_json)})),
    pipelines:db.prepare("SELECT d.pipeline_id AS pipelineId,d.storage_backend AS storageBackend,r.started_at AS startedAt,r.completed_at AS completedAt,r.status,r.error_code AS errorCode,c.updated_at AS lastPersistedAt FROM pipeline_definitions d LEFT JOIN pipeline_checkpoints c ON c.pipeline_id=d.pipeline_id LEFT JOIN pipeline_runs r ON r.run_id=(SELECT run_id FROM pipeline_runs WHERE pipeline_id=d.pipeline_id ORDER BY started_at DESC LIMIT 1) ORDER BY d.pipeline_id").all()
  })).deferred();
}
