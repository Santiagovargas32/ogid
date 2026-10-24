// Read-only, bounded telemetry. A completed interval is not automatic acceptance.
import { mkdirSync, openSync, closeSync, writeSync, writeFileSync, renameSync, readFileSync, existsSync,statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { setTimeout as wait } from "node:timers/promises";
import dotenv from "dotenv";

const numeric = o => Object.fromEntries(Object.entries(o || {}).filter(([,v]) => typeof v === "number" && Number.isFinite(v)));
const text=(value,max=128)=>typeof value==='string'?value.slice(0,max):null;
const number=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
const boolean=value=>typeof value==='boolean'?value:null;
const fields=(value,keys,project)=>Object.fromEntries(keys.map(key=>[key,project(value?.[key])]));
const nativeWaitSample=value=>value?{
  threadId:number(value.threadId),capturedAt:text(value.capturedAt),
  ...Object.fromEntries(['waitChannel','stack','ioPressure'].map(key=>[key,value[key]?{
    available:boolean(value[key].available),value:text(value[key].value,key==='waitChannel'?128:2048),code:text(value[key].code),truncated:boolean(value[key].truncated)
  }:null]))
}:null;
const sqlActivitySample=value=>value?{
  state:text(value.state),method:text(value.method),
  sql:typeof value.sql==='string'?value.sql.replace(/'(?:''|[^'])*'/g,'?').replace(/\b\d+(?:\.\d+)?\b/g,'?').slice(0,240):null,
  startedAt:text(value.startedAt),elapsedMs:number(value.elapsedMs),lastDurationMs:number(value.lastDurationMs),
  transaction:value.transaction?{phase:text(value.transaction.phase),depth:number(value.transaction.depth),startedAt:text(value.transaction.startedAt),elapsedMs:number(value.transaction.elapsedMs)}:null
}:null;
const failureSample=value=>value?{code:text(value.code),causeCode:text(value.causeCode),at:text(value.at),sqlActivity:sqlActivitySample(value.sqlActivity),nativeWait:nativeWaitSample(value.nativeWait),
  unconfirmedCount:Array.isArray(value.unconfirmedCommands)?value.unconfirmedCommands.length:null,undispatchedCount:Array.isArray(value.undispatchedCommands)?value.undispatchedCommands.length:null,undispatchedTruncated:boolean(value.undispatchedTruncated)}:null;
const checkpointSample=value=>value?{
  ...fields(value,['state','mode','limitScope','nextEligibleAt'],text),
  ...fields(value,['walBytes','softLimitBytes','hardLimitBytes','completed','failures'],number),backpressure:boolean(value.backpressure),
  confirmedGeneration:number(value.confirmedGeneration),dirtySince:text(value.dirtySince),commits:value.commits?fields(value.commits,['generation','bytes','at'],number):null,
  connection:value.connection?{queryOnly:boolean(value.connection.queryOnly),synchronous:number(value.connection.synchronous)}:null,
  active:value.active?{startedAt:text(value.active.startedAt),elapsedMs:number(value.active.elapsedMs)}:null,
  lastResult:value.lastResult?{...fields(value.lastResult,['busy','log','checkpointed','pendingFrames','pendingBytes','durationMs'],number),completedAt:text(value.lastResult.completedAt)}:null,
  lastError:value.lastError?{code:text(value.lastError.code),at:text(value.lastError.at),nativeWait:nativeWaitSample(value.lastError.nativeWait)}:null
}:null;
// Linux process metadata only; no argv, environments or private child output.
function managedMemory(runtime) {
  const seen=new Set(),processes=[];
  const visit=(pid,component)=>{
    if(!Number.isSafeInteger(pid)||pid<=0||seen.has(pid)||seen.size>=32)return;
    seen.add(pid);
    try{
      const status=readFileSync(`/proc/${pid}/status`,'utf8'),rss=status.match(/^VmRSS:\s+(\d+)\s+kB/m);
      processes.push({pid,component,rssBytes:rss?Number(rss[1])*1024:null});
      for(const child of readFileSync(`/proc/${pid}/task/${pid}/children`,'utf8').trim().split(/\s+/).filter(Boolean))visit(Number(child),component);
    }catch{processes.push({pid,component,rssBytes:null});}
  };
  for(const [component,state]of Object.entries(runtime?.components||{}))visit(state.pid,component);
  return {processes,complete:processes.length>0&&processes.every(p=>p.rssBytes!==null),rssBytes:processes.length?processes.reduce((sum,p)=>sum+(p.rssBytes||0),0):null};
}
const workerSample = storage => {
  const heartbeatAt=storage?.worker?.heartbeatAt || null;
  const age=heartbeatAt ? Date.now()-Date.parse(heartbeatAt) : NaN;
  return { heartbeatAt, heartbeatAgeMs:Number.isFinite(age)?Math.max(0,age):null, failed:storage?.failed ?? null,
    sqlActivity:sqlActivitySample(storage?.worker?.sqlActivity||storage?.failure?.sqlActivity),failure:failureSample(storage?.failure),
    activeCommands:(storage?.activeCommands || []).slice(0,16).map(c=>({operation:c.operation,service:c.service,method:c.method,phase:c.phase,elapsedMs:c.elapsedMs,executionMs:c.executionMs})),
    lastExpiredCommand:storage?.lastExpiredCommand ? {operation:storage.lastExpiredCommand.operation,service:storage.lastExpiredCommand.service,method:storage.lastExpiredCommand.method,phase:storage.lastExpiredCommand.phase,timeoutMs:storage.lastExpiredCommand.timeoutMs} : null };
};
export async function shadowSample({ base = "http://127.0.0.1:3000", token = "", fetchImpl = fetch } = {}) {
  const probe = async path => {
    const started = performance.now();
    try {
      const response = await fetchImpl(new URL(path, base), { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(10000), redirect: "error" });
      const value = await response.json();
      return { http: response.status, latencyMs: Math.round(performance.now() - started), value: value.data,availability:'observed' };
    } catch(error) {
      const cause=error.cause?.code || error.code;
      return { http:null,error:cause==='ECONNREFUSED'?'PROBE_CONNECTION_REFUSED':error.name==='TimeoutError'?'PROBE_TIMEOUT':'PROBE_UNAVAILABLE',availability:cause==='ECONNREFUSED'?'endpoint-refused':'unknown' };
    }
  };
  const [health, ready, agent] = await Promise.all([probe("/api/health"), probe("/api/health/ready"), probe("/api/admin/agent")]);
  const h = health.value || {}, a = agent.value || {};
  return {
    at: new Date().toISOString(), http: { health: health.http, ready: ready.http, agent: agent.http },
    probeAvailability:{health:health.availability,ready:ready.availability,agent:agent.availability},
    probeErrors:{health:health.error || null,ready:ready.error || null,agent:agent.error || null},
    probeLatencyMs: { health: health.latencyMs ?? null, ready: ready.latencyMs ?? null, agent: agent.latencyMs ?? null },
    status: h.status || null, uptimeSeconds: h.uptimeSeconds ?? null, pid: h.server?.pid ?? null, startedAt:h.server?.startedAt || null, build:h.build?.artifactHash || h.build?.buildCommit || null, rss: h.server?.memory?.rss ?? null,
    diagnostics:h.diagnostics?{operational:h.diagnostics.operational?.status||null,quality:h.diagnostics.quality?.status||null,causes:(h.diagnostics.causes||[]).slice(0,32).map(c=>({dimension:text(c.dimension),origin:text(c.origin),code:text(c.code),observedAt:text(c.observedAt)}))}:null,
    storage: { state: h.storage?.state || null, queue: numeric(h.storage?.queue), analysisState: h.storage?.analysis?.state || null,queriesState:h.storage?.queries?.state || null,
      walCheckpoint:checkpointSample(h.storage?.walCheckpoint),
      marketPersistence:{pending:number(h.storage?.worker?.database?.marketPersistence?.pending),active:number(h.storage?.marketPersistence?.active),retries:number(h.storage?.marketPersistence?.retries),lastErrorCode:text(h.storage?.marketPersistence?.lastError?.code)},
      queryRecovery:{recovering:h.storage?.queryRecovery?.recovering===true,recoveries:h.storage?.queryRecovery?.recoveries ?? 0},
      analysisRecovery:{recovering:h.storage?.analysisRecovery?.recovering === true,recoveries:h.storage?.analysisRecovery?.recoveries ?? 0},
      eventIndex:h.storage?.worker?.eventIndex || null,writer:workerSample(h.storage),analysis:workerSample(h.storage?.analysis),queries:workerSample(h.storage?.queries) },
    websocket: { clients: h.websocketClients ?? null, metrics: numeric(h.websocket?.metrics),sync:numeric(h.websocket?.synchronization?.metrics) },
    pipelines: Object.fromEntries(Object.entries(h.pipeline || {}).map(([k,v]) => [k,{ status: v.status || null }])),
    agent: { mode: a.mode || null,taskModes:a.taskModes || null, runtime: a.runtime || null, paused: a.paused ?? null, workerState: a.workerHealth?.state || null, workerError: a.workerHealth?.errorCode || null, jobs: (a.jobs || []).map(j=>({ status: j.status, count: j.count })),sinceCounts:a.sinceCounts || [],oldestQueuedAt:a.queueAge?.oldestQueuedAt || null,publicationCount:a.publicationCount??null, latestPublicationAt: a.latest?.publishedAt || null, recentRuns: (a.runs || []).slice(0,20).map(r=>({jobId:r.jobId,fence:r.fence, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt,progress:{phase:r.metadata?.phase,toolsCompleted:r.metadata?.toolsCompleted,lastProgressAt:r.metadata?.lastProgressAt,firstProgressMs:r.metadata?.firstProgressMs} })) },
  };
}

export function recordStorageDiagnostics(summary,sample){
  const checkpoint=sample.storage?.walCheckpoint;
  summary.walBackpressureSamples=(summary.walBackpressureSamples||0)+(checkpoint?.backpressure===true?1:0);
  summary.checkpointFailedSamples=(summary.checkpointFailedSamples||0)+(checkpoint?.state==='failed'?1:0);
  summary.checkpointUnknownSamples=(summary.checkpointUnknownSamples||0)+(!checkpoint?.state?1:0);
  for(const [key,value]of [['maxCheckpointPendingBytes',checkpoint?.lastResult?.pendingBytes],['maxCheckpointDurationMs',checkpoint?.lastResult?.durationMs],['maxCheckpointFailures',checkpoint?.failures]])
    summary[key]=value==null?(summary[key]??null):Math.max(summary[key]??value,value);
}

export function recordContinuity(summary,sample,{gapMs=0}={}) {
  summary.continuousBackendObservation ??= true;
  summary.backendChanges ??= 0;
  summary.telemetryGaps ??= 0;
  summary.segments ??= [];
  const identity=sample.pid && sample.startedAt ? `${sample.pid}:${sample.startedAt}:${sample.build||''}` : null;
  const available=Object.values(sample.http).every(status=>status===200);
  const backendObserved=sample.http.health!==null && Boolean(identity);
  const segment=summary.segments.at(-1);
  if(!backendObserved || gapMs>90000)summary.continuousBackendObservation=false;
  if(gapMs>90000)summary.telemetryGaps++;
  if(identity && summary.backendIdentity && identity!==summary.backendIdentity){summary.backendChanges++;summary.continuousBackendObservation=false;}
  if(identity)summary.backendIdentity=identity;
  if(!segment || segment.available!==available || segment.identity!==identity || segment.backendObserved!==backendObserved){
    if(summary.segments.length<128)summary.segments.push({from:sample.at,to:sample.at,identity,available,backendObserved,samples:1});
    else summary.segmentsTruncated=true;
  }else{segment.to=sample.at;segment.samples++;}
}

async function main() {
  const [directory, hoursText = "24"] = process.argv.slice(2), hours = Number(hoursText);
  if (!directory || !Number.isFinite(hours) || hours <= 0 || hours > 168) throw Error("Uso: node backend/scripts/agent-shadow-observe.js /ruta/nueva/informe [horas=24]");
  const out = resolve(directory); mkdirSync(out, { mode: 0o700, recursive: false });
  const file = openSync(join(out, "samples.jsonl"), "wx", 0o600);
  const envPath = new URL("../.env", import.meta.url);
  const env = { ...(existsSync(envPath) ? dotenv.parse(readFileSync(envPath)) : {}), ...process.env };
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort()); process.once("SIGINT", () => controller.abort());
  const started = performance.now(), expectedMs = hours * 3600000;
  const summary = { startedAt: new Date().toISOString(), requestedHours: hours, samples: 0, unavailableSamples: 0, notShadowSamples: 0, workerDisconnectedSamples: 0, storageHeartbeatDelayedSamples:0, maxAnalysisRecoveries:0,maxQueryRecoveries:0, maxGapMs: 0, maxRss: 0, state: "observing", completedObservation: false, acceptance: "manual-review-required" };
  let previous = null;
  const save = () => { writeFileSync(join(out,"summary.json.tmp"),JSON.stringify(summary,null,2)+"\n",{mode:0o600}); renameSync(join(out,"summary.json.tmp"),join(out,"summary.json")); };
  console.log(JSON.stringify({state:"observing",output:out,requestedHours:hours,sampleIntervalSeconds:60}));
  try {
    while (!controller.signal.aborted) {
      const now = performance.now(); if(previous !== null)summary.maxGapMs=Math.max(summary.maxGapMs,Math.round(now-previous));previous=now;
      const sample = await shadowSample({ base: `http://127.0.0.1:${env.PORT || "3000"}`, token: env.ADMIN_API_TOKEN || "" });
      sample.managedMemory=managedMemory(sample.agent.runtime);
      try{sample.walBytes=statSync(`${env.STORAGE_DB_PATH}-wal`).size;}catch{sample.walBytes=null;}
      if(sample.managedMemory.complete)summary.maxManagedRss=Math.max(summary.maxManagedRss||0,sample.managedMemory.rssBytes);
      if(sample.walBytes!==null)summary.maxWalBytes=Math.max(summary.maxWalBytes||0,sample.walBytes);
      writeSync(file, JSON.stringify(sample)+"\n"); summary.samples++;
      if (Object.values(sample.http).some(status=>status !== 200)) summary.unavailableSamples++;
      if(sample.probeAvailability.health==='endpoint-refused')summary.endpointRefusedSamples=(summary.endpointRefusedSamples||0)+1;
      else if(sample.http.health===null)summary.unknownBackendSamples=(summary.unknownBackendSamples||0)+1;
      if (!sample.agent.mode)summary.unknownModeSamples=(summary.unknownModeSamples||0)+1;
      else if (sample.agent.mode !== "shadow" || Object.values(sample.agent.taskModes||{}).includes('visible')) summary.notShadowSamples++;
      if (!sample.agent.workerState || sample.agent.workerState==='unknown')summary.unknownWorkerSamples=(summary.unknownWorkerSamples||0)+1;
      else if(sample.agent.workerState !== 'connected')summary.workerUnhealthySamples=(summary.workerUnhealthySamples||0)+1;
      if (sample.agent.workerState==='disconnected') summary.workerDisconnectedSamples++;
      recordContinuity(summary,sample,{gapMs:summary.lastSample?Date.parse(sample.at)-Date.parse(summary.lastSample.at):0});
      recordStorageDiagnostics(summary,sample);
      if ([sample.storage.writer,sample.storage.analysis,sample.storage.queries].some(w=>w.heartbeatAgeMs>15000))summary.storageHeartbeatDelayedSamples++;
      summary.maxQueryRecoveries=Math.max(summary.maxQueryRecoveries,sample.storage.queryRecovery.recoveries);
      summary.maxAnalysisRecoveries=Math.max(summary.maxAnalysisRecoveries,sample.storage.analysisRecovery.recoveries);
      summary.maxSyncConflicts=Math.max(summary.maxSyncConflicts||0,sample.websocket.sync.conflicts||0);
      summary.maxSyncCapacityRejected=Math.max(summary.maxSyncCapacityRejected||0,sample.websocket.sync.capacityRejected||0);
      summary.maxRss = Math.max(summary.maxRss, sample.rss || 0);
      summary.lastSample = sample; summary.observedMs = Math.round(performance.now()-started);
      console.log(JSON.stringify({at:sample.at,ready:sample.http.ready,agent:sample.http.agent,mode:sample.agent.mode,worker:sample.agent.workerState,jobs:sample.agent.jobs,latestPublicationAt:sample.agent.latestPublicationAt,writerHeartbeatAgeMs:sample.storage.writer.heartbeatAgeMs,analysisRecoveries:sample.storage.analysisRecovery.recoveries}));
      if (summary.observedMs >= expectedMs) { summary.state="completed";summary.completedObservation=true;save();break; }
      save();
      await wait(Math.min(60000,expectedMs-(performance.now()-started)),undefined,{signal:controller.signal}).catch(()=>{});
    }
  } finally { closeSync(file); if(!summary.completedObservation)summary.state="interrupted";summary.finishedAt=new Date().toISOString();save(); }
  console.log(JSON.stringify({ output: out, state: summary.state, samples: summary.samples, completedObservation: summary.completedObservation, acceptance: summary.acceptance }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("No se pudo completar la observación; revisar ruta, permisos y conectividad local."); process.exitCode=1; });
}
