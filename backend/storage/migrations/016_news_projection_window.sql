-- Read cache identities from a covering index before opening large bodies.
-- Same-revision reception/provenance refreshes still invalidate the cached row.
CREATE INDEX articles_projection_window ON articles(
 published_at DESC,article_id DESC,revision,last_seen_at
);
