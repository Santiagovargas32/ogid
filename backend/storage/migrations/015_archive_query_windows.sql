-- Narrow immutable revision references before decoding article bodies.
-- Publication windows already use article_revisions_window (migration 012).
CREATE INDEX article_revisions_changed_window ON article_revisions(
 json_extract(payload_json,'$.archiveChangedAt') DESC,article_id,revision
);
CREATE INDEX article_revisions_received_window ON article_revisions(
 json_extract(payload_json,'$.receivedAt') DESC,article_id,revision
);
CREATE INDEX article_revisions_updated_window ON article_revisions(
 json_extract(payload_json,'$.updatedAt') DESC,article_id,revision
);

-- Polling an unchanged source must not hydrate its entire event history.
CREATE INDEX awareness_source_freshness ON awareness_events(
 source_id,coalesce(json_extract(payload_json,'$.provenance.stale'),0),
 json_extract(payload_json,'$.dataMode'),event_id
);
