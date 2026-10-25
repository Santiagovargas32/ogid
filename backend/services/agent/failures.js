// Inspect private error text only to classify it; never return the text/body.
export function terminalFailure(error = {}) {
  const message = typeof error.message === 'string' ? error.message.slice(0,4096) : '';
  const type = typeof error.type === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(error.type) ? error.type : 'unknown';
  const brokerCause=message.match(/^OGID upstream failure: (BROKER_INCOMPLETE_STREAM)$/)?.[1];
  const causeCode = brokerCause ? brokerCause : /expected peg-native format|does not match the expected .* format/i.test(message) ? 'LLAMACPP_OUTPUT_FORMAT'
    : /abort|cancel|interrupt/i.test(message) ? 'INFERENCE_CANCELLED'
    : /timeout|timed out/i.test(message) ? 'INFERENCE_TIMEOUT'
    : /ECONN|connection|socket|fetch failed/i.test(message) ? 'INFERENCE_CONNECTION'
    : type.startsWith('tool') ? 'MCP_TOOL_FAILED' : Number.isInteger(error.status)&&error.status>=400 ? `INFERENCE_HTTP_${error.status}` : 'INFERENCE_PROVIDER_ERROR';
  return {causeCode,type,httpStatus:Number.isInteger(error.status)?error.status:null,phase:'model-response',observedAt:new Date().toISOString()};
}
export function transportFailure(error,prefix='OPENCODE') {
  const code=error?.cause?.code||error?.code||'';
  const kind=error?.name==='TimeoutError'||/TIMEOUT/.test(code)?'TIMEOUT'
    :error?.name==='AbortError'?'CANCELLED'
    :['ENOTFOUND','EAI_AGAIN'].includes(code)?'DNS'
    :/TLS|SSL|CERT/.test(code)?'TLS'
    :/ECONN|EPIPE|SOCKET/.test(code)?'CONNECTION':'TRANSPORT';
  return {causeCode:`${prefix}_${kind}`,phase:prefix==='OPENCODE'?'opencode-http':'upstream-http',httpStatus:null,observedAt:new Date().toISOString()};
}
