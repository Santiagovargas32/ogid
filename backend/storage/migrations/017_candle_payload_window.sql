-- Resolve stable candle versions from a covering index before ordered payload reads.
CREATE INDEX candles_payload_window ON candles(instrument_id,interval,adjustment_mode,dataset_id,open_time DESC,revision,fetched_at);
