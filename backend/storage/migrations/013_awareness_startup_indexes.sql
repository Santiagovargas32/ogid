-- Select the upcoming projection from index entries before reading JSON bodies.
-- The existing awareness_by_time index serves the bounded recent projection.
CREATE INDEX awareness_upcoming_schedule ON awareness_events(
  json_extract(payload_json,'$.scheduledAt'),observed_at DESC,event_id
) WHERE json_extract(payload_json,'$.status') IN ('scheduled','live');

-- Startup and source snapshots read the last seven days across all sources.
CREATE INDEX source_polls_completed ON source_polls(completed_at);
