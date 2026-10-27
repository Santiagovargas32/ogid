-- Situation detail must use a bounded index range in both directions.
CREATE INDEX situation_incident_reverse ON situation_incident_links(situation_id,incident_id,created_sequence);
