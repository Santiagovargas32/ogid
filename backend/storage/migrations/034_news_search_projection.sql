-- Search filters and exact totals need only this compact projection. Full
-- immutable source bodies are read for the response page, never for counting.
-- The existing writer maintains it atomically with each immutable revision.
CREATE TABLE news_search_projection (
  article_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  revision_rowid INTEGER NOT NULL UNIQUE,
  published_at ANY,
  received_at ANY,
  updated_at ANY,
  archive_changed_at ANY,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  FOREIGN KEY(article_id,revision) REFERENCES article_revisions(article_id,revision) ON DELETE CASCADE
) STRICT;

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
    'provenances',(SELECT json_group_array(json_object(
      'provider',json_extract(p.value,'$.provider'),
      'sourceId',json_extract(p.value,'$.sourceId'),
      'publisher',json_extract(p.value,'$.publisher')
    )) FROM json_each(r.payload_json,'$.provenances') p)
  ) AS payload_json
FROM article_revisions r;

INSERT INTO news_search_projection
SELECT fields.* FROM (
  SELECT article_id,max(revision) AS revision FROM article_revisions GROUP BY article_id
) latest JOIN news_search_revision_fields fields
  ON fields.article_id=latest.article_id AND fields.revision=latest.revision;

CREATE INDEX news_search_publication ON news_search_projection(published_at,article_id,revision_rowid);
CREATE INDEX news_search_reception ON news_search_projection(received_at,article_id,revision_rowid);
CREATE INDEX news_search_updated ON news_search_projection(updated_at,article_id,revision_rowid);
CREATE INDEX news_search_changed ON news_search_projection(archive_changed_at,article_id,revision_rowid);

CREATE TRIGGER news_search_revision_insert AFTER INSERT ON article_revisions BEGIN
  INSERT INTO news_search_projection
    SELECT * FROM news_search_revision_fields WHERE revision_rowid=NEW.rowid
  ON CONFLICT(article_id) DO UPDATE SET
    revision=excluded.revision,revision_rowid=excluded.revision_rowid,
    published_at=excluded.published_at,received_at=excluded.received_at,
    updated_at=excluded.updated_at,archive_changed_at=excluded.archive_changed_at,
    payload_json=excluded.payload_json
  WHERE excluded.revision>news_search_projection.revision;
END;
