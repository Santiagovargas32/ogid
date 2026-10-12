CREATE TABLE pipeline_stage_state (
  stage_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','degraded','blocked','failed','stale','disabled')),
  updated_at TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK(json_valid(state_json))
) STRICT;
CREATE INDEX pipeline_stage_by_status ON pipeline_stage_state(status,updated_at);
