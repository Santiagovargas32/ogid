CREATE TABLE event_instruments (
  event_id TEXT NOT NULL REFERENCES events(event_id),
  instrument_id TEXT NOT NULL REFERENCES instruments(instrument_id),
  impact_json TEXT NOT NULL CHECK(json_valid(impact_json)),
  PRIMARY KEY(instrument_id,event_id)
) STRICT;
CREATE INDEX event_links_by_event ON event_instruments(event_id);
