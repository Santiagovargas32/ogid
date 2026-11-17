// Diagnostic overrides are finite and leave the deployment policy unchanged.
export function validateAdvancedMaintenanceMode(mode){
  if(!['continuous','on-demand'].includes(mode))throw Object.assign(new Error('Invalid advanced maintenance mode'),{code:'MAINTENANCE_PROFILE_INVALID'});
  return mode;
}
export function readMaintenanceProfile(args, {runtimeLimitMs=null,agentMode=null}={}) {
  const flags=args.filter(arg=>arg==='--maintenance-advanced'||arg.startsWith('--maintenance-advanced='));
  if(!flags.length)return null;
  const invalid=message=>Object.assign(new Error(message),{code:'MAINTENANCE_PROFILE_INVALID'});
  if(flags.length!==1)throw invalid('Specify --maintenance-advanced once.');
  const mode=flags[0].slice('--maintenance-advanced='.length);
  validateAdvancedMaintenanceMode(mode);
  if(!Number.isFinite(runtimeLimitMs)||runtimeLimitMs<=0)throw invalid('A maintenance diagnostic requires --run-for-ms.');
  if(agentMode!=='off')throw invalid('A maintenance diagnostic requires AGENT_MODE=off.');
  return {advancedMode:mode};
}
