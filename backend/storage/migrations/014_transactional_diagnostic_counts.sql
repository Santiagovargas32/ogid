-- Exact telemetry counts are maintained in the same transaction as each row.
-- Bootstrap once; heartbeats never scan historical payloads/indexes again.
CREATE TABLE storage_counts (name TEXT PRIMARY KEY, records INTEGER NOT NULL CHECK(records>=0)) STRICT;
INSERT INTO storage_counts SELECT 'articles',count(*) FROM articles;
CREATE TRIGGER storage_count_articles_insert AFTER INSERT ON articles BEGIN UPDATE storage_counts SET records=records+1 WHERE name='articles'; END;
CREATE TRIGGER storage_count_articles_delete AFTER DELETE ON articles BEGIN UPDATE storage_counts SET records=records-1 WHERE name='articles'; END;
INSERT INTO storage_counts SELECT 'article_revisions',count(*) FROM article_revisions;
CREATE TRIGGER storage_count_article_revisions_insert AFTER INSERT ON article_revisions BEGIN UPDATE storage_counts SET records=records+1 WHERE name='article_revisions'; END;
CREATE TRIGGER storage_count_article_revisions_delete AFTER DELETE ON article_revisions BEGIN UPDATE storage_counts SET records=records-1 WHERE name='article_revisions'; END;
INSERT INTO storage_counts SELECT 'events',count(*) FROM events;
CREATE TRIGGER storage_count_events_insert AFTER INSERT ON events BEGIN UPDATE storage_counts SET records=records+1 WHERE name='events'; END;
CREATE TRIGGER storage_count_events_delete AFTER DELETE ON events BEGIN UPDATE storage_counts SET records=records-1 WHERE name='events'; END;
INSERT INTO storage_counts SELECT 'candles',count(*) FROM candles;
CREATE TRIGGER storage_count_candles_insert AFTER INSERT ON candles BEGIN UPDATE storage_counts SET records=records+1 WHERE name='candles'; END;
CREATE TRIGGER storage_count_candles_delete AFTER DELETE ON candles BEGIN UPDATE storage_counts SET records=records-1 WHERE name='candles'; END;
INSERT INTO storage_counts SELECT 'candle_revisions',count(*) FROM candle_revisions;
CREATE TRIGGER storage_count_candle_revisions_insert AFTER INSERT ON candle_revisions BEGIN UPDATE storage_counts SET records=records+1 WHERE name='candle_revisions'; END;
CREATE TRIGGER storage_count_candle_revisions_delete AFTER DELETE ON candle_revisions BEGIN UPDATE storage_counts SET records=records-1 WHERE name='candle_revisions'; END;
INSERT INTO storage_counts SELECT 'quote_observations',count(*) FROM quote_observations;
CREATE TRIGGER storage_count_quote_observations_insert AFTER INSERT ON quote_observations BEGIN UPDATE storage_counts SET records=records+1 WHERE name='quote_observations'; END;
CREATE TRIGGER storage_count_quote_observations_delete AFTER DELETE ON quote_observations BEGIN UPDATE storage_counts SET records=records-1 WHERE name='quote_observations'; END;
INSERT INTO storage_counts SELECT 'signal_buckets',count(*) FROM signal_buckets;
CREATE TRIGGER storage_count_signal_buckets_insert AFTER INSERT ON signal_buckets BEGIN UPDATE storage_counts SET records=records+1 WHERE name='signal_buckets'; END;
CREATE TRIGGER storage_count_signal_buckets_delete AFTER DELETE ON signal_buckets BEGIN UPDATE storage_counts SET records=records-1 WHERE name='signal_buckets'; END;
INSERT INTO storage_counts SELECT 'awareness_events',count(*) FROM awareness_events;
CREATE TRIGGER storage_count_awareness_events_insert AFTER INSERT ON awareness_events BEGIN UPDATE storage_counts SET records=records+1 WHERE name='awareness_events'; END;
CREATE TRIGGER storage_count_awareness_events_delete AFTER DELETE ON awareness_events BEGIN UPDATE storage_counts SET records=records-1 WHERE name='awareness_events'; END;
INSERT INTO storage_counts SELECT 'source_polls',count(*) FROM source_polls;
CREATE TRIGGER storage_count_source_polls_insert AFTER INSERT ON source_polls BEGIN UPDATE storage_counts SET records=records+1 WHERE name='source_polls'; END;
CREATE TRIGGER storage_count_source_polls_delete AFTER DELETE ON source_polls BEGIN UPDATE storage_counts SET records=records-1 WHERE name='source_polls'; END;
INSERT INTO storage_counts SELECT 'ai_enrichments',count(*) FROM ai_enrichments;
CREATE TRIGGER storage_count_ai_enrichments_insert AFTER INSERT ON ai_enrichments BEGIN UPDATE storage_counts SET records=records+1 WHERE name='ai_enrichments'; END;
CREATE TRIGGER storage_count_ai_enrichments_delete AFTER DELETE ON ai_enrichments BEGIN UPDATE storage_counts SET records=records-1 WHERE name='ai_enrichments'; END;
INSERT INTO storage_counts SELECT 'acquisition_jobs',count(*) FROM acquisition_jobs;
CREATE TRIGGER storage_count_acquisition_jobs_insert AFTER INSERT ON acquisition_jobs BEGIN UPDATE storage_counts SET records=records+1 WHERE name='acquisition_jobs'; END;
CREATE TRIGGER storage_count_acquisition_jobs_delete AFTER DELETE ON acquisition_jobs BEGIN UPDATE storage_counts SET records=records-1 WHERE name='acquisition_jobs'; END;
INSERT INTO storage_counts SELECT 'analysis_runs',count(*) FROM analysis_runs;
CREATE TRIGGER storage_count_analysis_runs_insert AFTER INSERT ON analysis_runs BEGIN UPDATE storage_counts SET records=records+1 WHERE name='analysis_runs'; END;
CREATE TRIGGER storage_count_analysis_runs_delete AFTER DELETE ON analysis_runs BEGIN UPDATE storage_counts SET records=records-1 WHERE name='analysis_runs'; END;
CREATE TABLE storage_collection_counts (collection TEXT PRIMARY KEY, records INTEGER NOT NULL CHECK(records>=0)) STRICT;
INSERT INTO storage_collection_counts SELECT collection,count(*) FROM research_rows GROUP BY collection;
CREATE TRIGGER storage_collection_insert AFTER INSERT ON research_rows BEGIN
 INSERT INTO storage_collection_counts VALUES(new.collection,1) ON CONFLICT(collection) DO UPDATE SET records=records+1;
END;
CREATE TRIGGER storage_collection_delete AFTER DELETE ON research_rows BEGIN
 UPDATE storage_collection_counts SET records=records-1 WHERE collection=old.collection;
END;
CREATE TRIGGER storage_collection_move AFTER UPDATE OF collection ON research_rows WHEN old.collection!=new.collection BEGIN
 UPDATE storage_collection_counts SET records=records-1 WHERE collection=old.collection;
 INSERT INTO storage_collection_counts VALUES(new.collection,1) ON CONFLICT(collection) DO UPDATE SET records=records+1;
END;

