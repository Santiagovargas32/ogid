-- Derived coverage/claims. Existing articles, revisions and agent snapshots stay intact.
CREATE TABLE news_comparison_changes (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 kind TEXT NOT NULL, entity_id TEXT NOT NULL, changed_at TEXT NOT NULL,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
) STRICT;
CREATE TABLE news_comparison_groups (
 group_id TEXT PRIMARY KEY, signature TEXT NOT NULL, anchor_at TEXT NOT NULL,
 created_sequence INTEGER NOT NULL REFERENCES news_comparison_changes(sequence),
 auto_admission INTEGER NOT NULL CHECK(auto_admission IN (0,1))
) STRICT;
CREATE INDEX news_comparison_candidates ON news_comparison_groups(signature,anchor_at,group_id) WHERE auto_admission=1;
CREATE INDEX news_comparison_group_time ON news_comparison_groups(anchor_at,group_id);
CREATE TABLE news_comparison_group_versions (
 group_id TEXT NOT NULL REFERENCES news_comparison_groups(group_id),
 change_sequence INTEGER NOT NULL REFERENCES news_comparison_changes(sequence),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 PRIMARY KEY(group_id,change_sequence)
) STRICT;
CREATE TABLE news_comparison_publication_versions (
 article_id TEXT NOT NULL, article_revision INTEGER NOT NULL,
 publisher_id TEXT, origin_chain_id TEXT, effective_at TEXT NOT NULL,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 PRIMARY KEY(article_id,article_revision),
 FOREIGN KEY(article_id,article_revision) REFERENCES article_revisions(article_id,revision)
) STRICT;
CREATE TABLE news_comparison_publications (
 article_id TEXT PRIMARY KEY REFERENCES articles(article_id),
 article_revision INTEGER NOT NULL, change_sequence INTEGER NOT NULL,
 FOREIGN KEY(article_id,article_revision) REFERENCES news_comparison_publication_versions(article_id,article_revision)
) STRICT;
CREATE TABLE news_comparison_assignments (
 change_sequence INTEGER NOT NULL REFERENCES news_comparison_changes(sequence),
 article_id TEXT NOT NULL, article_revision INTEGER NOT NULL,
 group_id TEXT NOT NULL REFERENCES news_comparison_groups(group_id),
 locked INTEGER NOT NULL CHECK(locked IN (0,1)), origin_override TEXT, review_id TEXT,
 PRIMARY KEY(change_sequence,article_id),
 FOREIGN KEY(article_id,article_revision) REFERENCES news_comparison_publication_versions(article_id,article_revision)
) STRICT;
CREATE INDEX news_comparison_assignments_article ON news_comparison_assignments(article_id,change_sequence);
CREATE INDEX news_comparison_assignments_group ON news_comparison_assignments(group_id,article_id,change_sequence);
CREATE TABLE news_comparison_members (
 article_id TEXT PRIMARY KEY, article_revision INTEGER NOT NULL,
 group_id TEXT NOT NULL REFERENCES news_comparison_groups(group_id),
 change_sequence INTEGER NOT NULL, locked INTEGER NOT NULL,
 origin_override TEXT, review_id TEXT,
 FOREIGN KEY(change_sequence,article_id) REFERENCES news_comparison_assignments(change_sequence,article_id)
) STRICT;
CREATE INDEX news_comparison_members_group ON news_comparison_members(group_id,article_id);
CREATE TABLE news_comparison_claims (
 claim_id TEXT PRIMARY KEY, article_id TEXT NOT NULL, article_revision INTEGER NOT NULL,
 ordinal INTEGER NOT NULL, concept_key TEXT, modality TEXT NOT NULL,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 FOREIGN KEY(article_id,article_revision) REFERENCES news_comparison_publication_versions(article_id,article_revision)
) STRICT;
CREATE INDEX news_comparison_claims_article ON news_comparison_claims(article_id,article_revision,ordinal);
CREATE TABLE news_comparison_reviews (
 request_id TEXT PRIMARY KEY, review_id TEXT NOT NULL UNIQUE,
 change_sequence INTEGER NOT NULL REFERENCES news_comparison_changes(sequence),
 input_hash TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 result_json TEXT NOT NULL CHECK(json_valid(result_json))
) STRICT;
CREATE TABLE news_comparison_claim_links (
 link_id TEXT PRIMARY KEY, left_claim_id TEXT NOT NULL REFERENCES news_comparison_claims(claim_id),
 right_claim_id TEXT NOT NULL REFERENCES news_comparison_claims(claim_id),
 relation TEXT NOT NULL CHECK(relation IN ('support','contradiction','context')),
 change_sequence INTEGER NOT NULL REFERENCES news_comparison_changes(sequence),
 review_id TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
) STRICT;
CREATE INDEX news_comparison_links_left ON news_comparison_claim_links(left_claim_id,change_sequence);
CREATE INDEX news_comparison_links_right ON news_comparison_claim_links(right_claim_id,change_sequence);
