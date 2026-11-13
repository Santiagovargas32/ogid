-- Country/date searches need exact totals and frozen revision references, not
-- title/excerpt/provenance bodies. This index also covers quality and the final
-- country check; the existing writer maintains it atomically with projection.
-- Replace the four narrow indexes, preserving their date-first prefixes and
-- identities. Do not add a second set of indexes to each acquisition commit.
DROP INDEX news_search_publication;
CREATE INDEX news_search_publication ON news_search_projection (
  published_at,article_id,revision_rowid,received_at,updated_at,archive_changed_at,
  json_extract(payload_json,'$.countryMentions'),
  json_extract(payload_json,'$.synthetic'),
  json_extract(payload_json,'$.dataMode'),
  json_extract(payload_json,'$.provenance.stale')
);
DROP INDEX news_search_reception;
CREATE INDEX news_search_reception ON news_search_projection (
  received_at,article_id,revision_rowid,published_at,updated_at,archive_changed_at,
  json_extract(payload_json,'$.countryMentions'),
  json_extract(payload_json,'$.synthetic'),
  json_extract(payload_json,'$.dataMode'),
  json_extract(payload_json,'$.provenance.stale')
);
DROP INDEX news_search_updated;
CREATE INDEX news_search_updated ON news_search_projection (
  updated_at,article_id,revision_rowid,published_at,received_at,archive_changed_at,
  json_extract(payload_json,'$.countryMentions'),
  json_extract(payload_json,'$.synthetic'),
  json_extract(payload_json,'$.dataMode'),
  json_extract(payload_json,'$.provenance.stale')
);
DROP INDEX news_search_changed;
CREATE INDEX news_search_changed ON news_search_projection (
  archive_changed_at,article_id,revision_rowid,published_at,received_at,updated_at,
  json_extract(payload_json,'$.countryMentions'),
  json_extract(payload_json,'$.synthetic'),
  json_extract(payload_json,'$.dataMode'),
  json_extract(payload_json,'$.provenance.stale')
);
