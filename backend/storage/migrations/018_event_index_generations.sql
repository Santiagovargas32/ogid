-- Keep the previous complete index available while bounded pages build its replacement.
-- Application rollback to <=017 requires a compatible application, not schema edits.
CREATE TABLE event_index_links (
 generation TEXT NOT NULL,
 event_id TEXT NOT NULL REFERENCES events(event_id),
 instrument_id TEXT NOT NULL REFERENCES instruments(instrument_id),
 impact_json TEXT NOT NULL CHECK(json_valid(impact_json)),
 PRIMARY KEY(generation,instrument_id,event_id)
) STRICT;
CREATE INDEX event_index_links_by_event ON event_index_links(generation,event_id);
