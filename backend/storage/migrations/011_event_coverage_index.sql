-- Scenario refreshes request global identity coverage for each instrument.
-- Keep these aggregates off the large historical event payload rows.
CREATE INDEX events_by_identity ON events(identity_version);
