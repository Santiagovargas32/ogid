-- Avoid conflict-policy inheritance from an outer INSERT ... ON CONFLICT UPDATE.
DROP TRIGGER awareness_revision_update;
CREATE TRIGGER awareness_revision_update AFTER UPDATE ON awareness_events
 WHEN new.revision!=old.revision OR new.payload_json!=old.payload_json BEGIN
 SELECT CASE WHEN new.revision<=old.revision THEN RAISE(ABORT,'AWARENESS_REVISION_NOT_MONOTONIC') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM awareness_revisions WHERE event_id=old.event_id AND revision=old.revision AND payload_json!=old.payload_json)
 THEN RAISE(ABORT,'AWARENESS_JOURNAL_MISMATCH') END;
 INSERT INTO awareness_revisions(event_id,revision,source_id,available_at,baseline,payload_json)
 SELECT old.event_id,old.revision,old.source_id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,old.payload_json
 WHERE NOT EXISTS(SELECT 1 FROM awareness_revisions WHERE event_id=old.event_id AND revision=old.revision);
 INSERT INTO awareness_revisions(event_id,revision,source_id,available_at,baseline,payload_json)
 VALUES(new.event_id,new.revision,new.source_id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),0,new.payload_json);
END;
