const MAX_TIMER_MS=2147483647;
const invalid=()=>{throw Object.assign(new Error('Use one --run-for-ms=positive-integer within the Node timer range'),{code:'INVALID_RUNTIME_LIMIT'});};

// Optional operator bound for a run, not a business command timeout or retry.
export function readRuntimeLimit(args){
  const values=args.filter(arg=>arg==='--run-for-ms'||arg.startsWith('--run-for-ms='));
  if(!values.length)return null;
  if(values.length!==1||!/^--run-for-ms=[0-9]+$/.test(values[0]))invalid();
  const milliseconds=Number(values[0].slice('--run-for-ms='.length));
  if(!Number.isSafeInteger(milliseconds)||milliseconds<=0||milliseconds>MAX_TIMER_MS)invalid();
  return milliseconds;
}
export function armRuntimeLimit(milliseconds,shutdown){
  if(milliseconds===null)return ()=>{};
  const timer=setTimeout(()=>void shutdown('runtime-limit'),milliseconds);
  timer.unref();
  return ()=>clearTimeout(timer);
}
