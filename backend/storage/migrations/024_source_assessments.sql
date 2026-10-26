CREATE TABLE news_source_assessments (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 assessment_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1),
 publisher_id TEXT NOT NULL, edition TEXT NOT NULL, evaluator_id TEXT NOT NULL,
 political_scope TEXT NOT NULL, valid_from TEXT NOT NULL, valid_until TEXT,
 recorded_at TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 UNIQUE(assessment_id,revision)
) STRICT;
CREATE INDEX news_assessments_subject ON news_source_assessments(publisher_id,edition,recorded_at,assessment_id,revision);
CREATE TABLE news_publisher_profiles (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 publisher_id TEXT NOT NULL, edition TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1),
 recorded_at TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 UNIQUE(publisher_id,edition,revision)
) STRICT;
CREATE INDEX news_profiles_subject ON news_publisher_profiles(publisher_id,edition,recorded_at,revision);
-- Small read projection; populated in bounded pages, never by migration scan.
CREATE TABLE news_editorial_facets (
 article_id TEXT PRIMARY KEY REFERENCES articles(article_id),
 article_revision INTEGER NOT NULL, received_at TEXT NOT NULL,
 publisher_id TEXT, edition TEXT, language TEXT, origin_chain_id TEXT,
 country_mentions_json TEXT NOT NULL CHECK(json_valid(country_mentions_json))
) STRICT;
CREATE INDEX news_facets_window ON news_editorial_facets(received_at,publisher_id,edition,language,origin_chain_id);
