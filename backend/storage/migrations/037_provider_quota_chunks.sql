-- The existing writer publishes the compact quota manifest and immutable
-- ordered event chunks atomically. Readers retain one WAL cut while decoding.
CREATE TABLE provider_quota_chunks (
  chunk_sha256 TEXT PRIMARY KEY CHECK(length(chunk_sha256)=64),
  item_count INTEGER NOT NULL CHECK(item_count BETWEEN 1 AND 256),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)
    AND json_type(payload_json)='array'
    AND json_array_length(payload_json)=item_count)
) STRICT;
