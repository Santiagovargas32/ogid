CREATE TABLE articles (
  article_id TEXT PRIMARY KEY, title TEXT NOT NULL, excerpt TEXT, canonical_url TEXT,
  published_at TEXT, received_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=1), usage_policy TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  CHECK(usage_policy != 'headline-only-link-out' OR excerpt IS NULL)
) STRICT;
CREATE INDEX articles_by_publication ON articles(published_at DESC,article_id DESC);
CREATE INDEX articles_by_reception ON articles(received_at DESC,article_id DESC);
CREATE TABLE article_revisions (
  article_id TEXT NOT NULL REFERENCES articles(article_id), revision INTEGER NOT NULL,
  observed_at TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  PRIMARY KEY(article_id,revision)
) STRICT;
CREATE TABLE article_sources (
  article_id TEXT NOT NULL REFERENCES articles(article_id), source_id TEXT NOT NULL REFERENCES sources(source_id),
  observed_at TEXT NOT NULL, provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)),
  PRIMARY KEY(article_id,source_id)
) STRICT;
CREATE TABLE article_instruments (
  article_id TEXT NOT NULL REFERENCES articles(article_id), instrument_id TEXT NOT NULL REFERENCES instruments(instrument_id),
  PRIMARY KEY(instrument_id,article_id)
) STRICT;
CREATE TABLE article_countries (
  article_id TEXT NOT NULL REFERENCES articles(article_id), country TEXT NOT NULL,
  PRIMARY KEY(country,article_id)
) STRICT;
CREATE TABLE article_topics (
  article_id TEXT NOT NULL REFERENCES articles(article_id), topic TEXT NOT NULL,
  PRIMARY KEY(topic,article_id)
) STRICT;
CREATE VIRTUAL TABLE articles_fts USING fts5(title,excerpt,content='articles',content_rowid='rowid');
CREATE TRIGGER articles_ai AFTER INSERT ON articles BEGIN
  INSERT INTO articles_fts(rowid,title,excerpt) VALUES(new.rowid,new.title,new.excerpt);
END;
CREATE TRIGGER articles_ad AFTER DELETE ON articles BEGIN
  INSERT INTO articles_fts(articles_fts,rowid,title,excerpt) VALUES('delete',old.rowid,old.title,old.excerpt);
END;
CREATE TRIGGER articles_au AFTER UPDATE OF title,excerpt ON articles BEGIN
  INSERT INTO articles_fts(articles_fts,rowid,title,excerpt) VALUES('delete',old.rowid,old.title,old.excerpt);
  INSERT INTO articles_fts(rowid,title,excerpt) VALUES(new.rowid,new.title,new.excerpt);
END;
CREATE TABLE events (
  event_id TEXT PRIMARY KEY, source_id TEXT REFERENCES sources(source_id),
  identity_version TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1),
  published_at TEXT, observed_at TEXT NOT NULL, status TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
) STRICT;
CREATE INDEX events_by_time ON events(observed_at DESC,event_id);
CREATE TABLE event_revisions (
  event_id TEXT NOT NULL REFERENCES events(event_id), revision INTEGER NOT NULL,
  observed_at TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  PRIMARY KEY(event_id,revision)
) STRICT;
CREATE TABLE evidence (
  evidence_id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(event_id),
  article_id TEXT REFERENCES articles(article_id), source_id TEXT REFERENCES sources(source_id),
  available_at TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
) STRICT;
CREATE INDEX evidence_by_event ON evidence(event_id,available_at);
CREATE TABLE news_context (
  bucket TEXT PRIMARY KEY, observed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
) STRICT;
CREATE TABLE source_polls (
  poll_id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(source_id),
  completed_at TEXT NOT NULL, outcome TEXT NOT NULL,
  diagnostics_json TEXT NOT NULL CHECK(json_valid(diagnostics_json))
) STRICT;
CREATE INDEX source_polls_by_time ON source_polls(source_id,completed_at DESC);
