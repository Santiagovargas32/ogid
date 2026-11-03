// Shared bounded projection for HTTP, MCP and durable agent diagnostics.
// Never reflect error bodies, paths, credentials or source text.
export function resourcePressureDetails(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  if (['unknown', 'normal', 'degraded', 'recovering'].includes(value.state)) result.state = value.state;
  if (typeof value.critical === 'boolean') result.critical = value.critical;
  if (['low-memory', 'memory-pressure', 'io-pressure', 'critical-pressure', 'sample-unavailable', 'sample-updating', 'recovery-window'].includes(value.reason)) result.reason = value.reason;
  for (const key of ['availableBytes', 'sampledAt', 'ageMs', 'retryAfterMs'])
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) result[key] = value[key];
  for (const key of ['memoryFull', 'ioFull'])
    if (Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 100) result[key] = value[key];
  if (typeof value.notExecuted === 'boolean') result.notExecuted = value.notExecuted;
  return Object.keys(result).length ? result : null;
}
