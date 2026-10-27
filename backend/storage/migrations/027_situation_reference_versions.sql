-- Freeze incident associations/evidence at the domain sequence used by a cursor.
ALTER TABLE situation_incident_links ADD COLUMN created_sequence INTEGER NOT NULL DEFAULT 0;
CREATE TABLE situation_incident_ref_versions (
 incident_id TEXT NOT NULL REFERENCES situation_entities(entity_id),
 domain_sequence INTEGER NOT NULL REFERENCES situation_revisions(sequence),
 stream TEXT NOT NULL, source_id TEXT NOT NULL,
 source_revision INTEGER NOT NULL, source_sequence INTEGER NOT NULL,
 PRIMARY KEY(incident_id,domain_sequence,stream,source_id)
) STRICT;
CREATE INDEX situation_incident_ref_cut ON situation_incident_ref_versions(incident_id,stream,source_id,domain_sequence DESC);
CREATE INDEX geopolitical_alert_revision_cut ON geopolitical_alert_changes(alert_id,revision,sequence);
