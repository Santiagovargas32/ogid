-- Current poll metadata is separate from the large immutable/base article row.
-- articles.last_seen_at still versions that base payload in its covering index.
CREATE TABLE article_observations (
  article_id TEXT PRIMARY KEY REFERENCES articles(article_id) ON DELETE CASCADE,
  article_revision INTEGER NOT NULL CHECK(article_revision > 0),
  last_seen_at TEXT NOT NULL,
  base_sha256 TEXT NOT NULL CHECK(length(base_sha256) = 64),
  clocks_json TEXT NOT NULL CHECK(json_valid(clocks_json)),
  record_sha256 TEXT NOT NULL CHECK(length(record_sha256) = 64)
) STRICT;
