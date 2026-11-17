-- A source may have more than one page. Do not sort its complete history on
-- every durable freshness transition page.
CREATE INDEX awareness_source_event_page ON awareness_events(source_id,event_id);
