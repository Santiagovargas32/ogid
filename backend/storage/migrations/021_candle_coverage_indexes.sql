-- Coverage reads use only metadata, without visiting OHLCV payload pages.
CREATE INDEX candles_coverage_metadata ON candles(
 instrument_id,interval,adjustment_mode,dataset_id,session_key,revision,close_time
);
CREATE INDEX candle_validations_coverage ON candle_validations(
 instrument_id,interval,adjustment_mode,dataset_id,session_key,candle_revision,method_version,eligible
);
