-- Frozen evidence must find one scoped technical revision without parsing
-- every historical analysis payload for each instrument/timeframe.
CREATE INDEX analysis_runs_instrument_time ON analysis_runs(
  kind,json_extract(payload_json,'$.instrumentId'),
  json_extract(payload_json,'$.interval'),generated_at DESC
) WHERE kind IN ('technical.get','indicators.calculate');

-- Recovery touches interrupted runs only, preserving the complete audit log.
CREATE INDEX pipeline_runs_by_status ON pipeline_runs(status);

-- Resolve temporal eligibility from the index, before fetching the permitted
-- payloads in physical batches. Avoid historical JSON reads for rejected rows.
CREATE INDEX article_revisions_window ON article_revisions(
  json_extract(payload_json,'$.publishedAt'),observed_at,article_id,revision
);
