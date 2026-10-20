// Read-only, bounded telemetry. A completed interval is not automatic acceptance.
import { mkdirSync, openSync, closeSync, writeSync, writeFileSync, renameSync, readFileSync, existsSync,statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { setTimeout as wait } from "node:timers/promises";
import dotenv from "dotenv";

const numeric = o => Object.fromEntries(Object.entries(o || {}).filter(([,v]) => typeof v === "number" && Number.isFinite(v)));
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
    activeCommands:(storage?.activeCommands || []).slice(0,16).map(c=>({operation:c.operation,service:c.service,method:c.method,phase:c.phase,elapsedMs:c.elapsedMs,executionMs:c.executionMs})),
    lastExpiredCommand:storage?.lastExpiredCommand ? {operation:storage.lastExpiredCommand.operation,service:storage.lastExpiredCommand.service,method:storage.lastExpiredCommand.method,phase:storage.lastExpiredCommand.phase,timeoutMs:storage.lastExpiredCommand.timeoutMs} : null };
};
export async function shadowSample({ base = "http://127.0.0.1:3000", token = "", fetchImpl = fetch } = {}) {
  const probe = async path => {
    const started = performance.now();
    try {
      const response = await fetchImpl(new URL(path, base), { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(10000), redirect: "error" });
      const value = await response.json();
      return { http: response.status, latencyMs: Math.round(performance.now() - started), value: value.data };
    } catch { return { http: null, error: "PROBE_UNAVAILABLE" }; }
  };
  const [health, ready, agent] = await Promise.all([probe("/api/health"), probe("/api/health/ready"), probe("/api/admin/agent")]);
  const h = health.value || {}, a = agent.value || {};
  return {
    at: new Date().toISOString(), http: { health: health.http, ready: ready.http, agent: agent.http },
    probeLatencyMs: { health: health.latencyMs ?? null, ready: ready.latencyMs ?? null, agent: agent.latencyMs ?? null },
    status: h.status || null, uptimeSeconds: h.uptimeSeconds ?? null, pid: h.server?.pid ?? null, rss: h.server?.memory?.rss ?? null,
    storage: { state: h.storage?.state || null, queue: numeric(h.storage?.queue), analysisState: h.storage?.analysis?.state || null,queriesState:h.storage?.queries?.state || null,
      queryRecovery:{recovering:h.storage?.queryRecovery?.recovering===true,recoveries:h.storage?.queryRecovery?.recoveries ?? 0},
      analysisRecovery:{recovering:h.storage?.analysisRecovery?.recovering === true,recoveries:h.storage?.analysisRecovery?.recoveries ?? 0},
      eventIndex:h.storage?.worker?.eventIndex || null,writer:workerSample(h.storage),analysis:workerSample(h.storage?.analysis),queries:workerSample(h.storage?.queries) },
    websocket: { clients: h.websocketClients ?? null, metrics: numeric(h.websocket?.metrics) },
    pipelines: Object.fromEntries(Object.entries(h.pipeline || {}).map(([k,v]) => [k,{ status: v.status || null }])),
    agent: { mode: a.mode || null,taskModes:a.taskModes || null, runtime: a.runtime || null, paused: a.paused ?? null, workerState: a.workerHealth?.state || null, workerError: a.workerHealth?.errorCode || null, jobs: (a.jobs || []).map(j=>({ status: j.status, count: j.count })),sinceCounts:a.sinceCounts || [],oldestQueuedAt:a.queueAge?.oldestQueuedAt || null,publicationCount:a.publicationCount??null, latestPublicationAt: a.latest?.publishedAt || null, recentRuns: (a.runs || []).slice(0,20).map(r=>({jobId:r.jobId, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt,progress:{phase:r.metadata?.phase,toolsCompleted:r.metadata?.toolsCompleted,lastProgressAt:r.metadata?.lastProgressAt,firstProgressMs:r.metadata?.firstProgressMs} })) },
  };
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
      if (!sample.agent.mode)summary.unknownModeSamples=(summary.unknownModeSamples||0)+1;
      else if (sample.agent.mode !== "shadow" || Object.values(sample.agent.taskModes||{}).includes('visible')) summary.notShadowSamples++;
      if (sample.agent.workerState !== "connected") summary.workerDisconnectedSamples++;
      if ([sample.storage.writer,sample.storage.analysis,sample.storage.queries].some(w=>w.heartbeatAgeMs>15000))summary.storageHeartbeatDelayedSamples++;
      summary.maxQueryRecoveries=Math.max(summary.maxQueryRecoveries,sample.storage.queryRecovery.recoveries);
      summary.maxAnalysisRecoveries=Math.max(summary.maxAnalysisRecoveries,sample.storage.analysisRecovery.recoveries);
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
