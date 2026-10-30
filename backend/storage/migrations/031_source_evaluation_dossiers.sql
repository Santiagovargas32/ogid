CREATE TABLE source_evaluation_dossiers (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 dossier_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 publisher_id TEXT NOT NULL, edition TEXT NOT NULL,
 recorded_at TEXT NOT NULL, content_hash TEXT NOT NULL,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 UNIQUE(dossier_id,revision)
) STRICT;
CREATE INDEX source_dossiers_subject ON source_evaluation_dossiers(publisher_id,edition,sequence);
CREATE TABLE source_evaluation_reviews (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 dossier_id TEXT NOT NULL, revision INTEGER NOT NULL,
 content_hash TEXT NOT NULL, decision TEXT NOT NULL CHECK(decision IN ('approve','reject','changes-requested','withdraw')),
 reviewer TEXT NOT NULL, reason TEXT NOT NULL, recorded_at TEXT NOT NULL,
 FOREIGN KEY(dossier_id,revision) REFERENCES source_evaluation_dossiers(dossier_id,revision)
) STRICT;
CREATE INDEX source_reviews_revision ON source_evaluation_reviews(dossier_id,revision,sequence);
CREATE TABLE source_evaluation_requests (
 request_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL,
 result_json TEXT NOT NULL CHECK(json_valid(result_json))
) STRICT;
