export function recoveryAfter(previous = {}, {status,causeCode,jobId,fence,now,random=Math.random}) {
  if (status === 'completed') return {consecutiveFailures:0,level:0,nextEligibleAt:null,probe:null,lastSuccessAt:new Date(now).toISOString(),lastFailure:previous.lastFailure||null};
  if(status==='incomplete')return previous;
  const relevant = ['MCP_INVALID_ARGUMENTS','LLAMACPP_OUTPUT_FORMAT'].includes(causeCode);
  if (!relevant) return {...previous,probe:previous.probe?.jobId===jobId?null:previous.probe};
  const consecutiveFailures=(previous.consecutiveFailures||0)+1;
  const level=consecutiveFailures>=3?Math.min(20,(previous.level||0)+1):0;
  const delay=level?Math.min(900000,Math.round(60000*2**Math.min(4,level-1)*(.8+.4*random()))):0;
  return {...previous,consecutiveFailures,level,probe:null,nextEligibleAt:delay?new Date(now+delay).toISOString():null,
    lastFailure:{jobId,fence,causeCode,at:new Date(now).toISOString()}};
}
