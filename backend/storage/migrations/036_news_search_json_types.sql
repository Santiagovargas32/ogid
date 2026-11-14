-- A scalar subquery can discard the JSON subtype in newer SQLite versions.
-- Explicitly mark its aggregate as JSON before embedding the provenance array.
-- Existing migration checksums and immutable article revisions stay unchanged.
DROP VIEW news_search_revision_fields;
CREATE VIEW news_search_revision_fields AS
SELECT r.article_id,r.revision,r.rowid AS revision_rowid,
  json_extract(r.payload_json,'$.publishedAt') AS published_at,
  json_extract(r.payload_json,'$.receivedAt') AS received_at,
  json_extract(r.payload_json,'$.updatedAt') AS updated_at,
  json_extract(r.payload_json,'$.archiveChangedAt') AS archive_changed_at,
  json_object(
    'title',json_extract(r.payload_json,'$.title'),
    'excerpt',json_extract(r.payload_json,'$.excerpt'),
    'countryMentions',json_extract(r.payload_json,'$.countryMentions'),
    'instrumentIds',json_extract(r.payload_json,'$.instrumentIds'),
    'sectors',json_extract(r.payload_json,'$.sectors'),
    'topics',json_extract(r.payload_json,'$.topics'),
    'synthetic',json_extract(r.payload_json,'$.synthetic'),
    'dataMode',json_extract(r.payload_json,'$.dataMode'),
    'provenance',json_object('stale',json_extract(r.payload_json,'$.provenance.stale')),
    'provenances',json((SELECT json_group_array(json_object(
      'provider',json_extract(p.value,'$.provider'),
      'sourceId',json_extract(p.value,'$.sourceId'),
      'publisher',json_extract(p.value,'$.publisher')
    )) FROM json_each(r.payload_json,'$.provenances') p))
  ) AS payload_json
FROM article_revisions r;

-- Repair only derived arrays encoded as strings by the previous view. Correct
-- projections retain their bytes and rowids; the writer's existing trigger uses
-- the corrected view for future revisions in the same transaction.
UPDATE news_search_projection
SET payload_json=json_set(payload_json,'$.provenances',
  json(json_extract(payload_json,'$.provenances')))
WHERE json_type(payload_json,'$.provenances')='text'
  AND CASE WHEN json_valid(json_extract(payload_json,'$.provenances'))
    THEN json_type(json_extract(payload_json,'$.provenances'))='array' ELSE 0 END;
