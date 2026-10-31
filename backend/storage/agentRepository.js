import {requestAgent,captureContext,validateContext} from './agentRequests.js';
import {requestAnalysis,prepareAnalysis,commitAnalysisDependencies,analysisCurrentness,readAnalyses} from './situationAnalyses.js';
import {SituationStore} from './situations.js';
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { performance } from 'node:perf_hooks';
import { stableHash } from "../utils/stableHash.js";
import { AGENT_POLICY } from "../services/agent/config.js";
import { numericPaths, NUMERIC_CONTRACT_VERSION } from '../services/agent/evidencePaths.js';
import { summarizeProposals } from '../services/agent/proposalMetrics.js';
import {NEWS_FRESHNESS_POLICY} from '../services/news/newsFreshness.js';
import { recoveryAfter } from '../services/agent/recovery.js';
import { OPERATIONS_HASH } from '../contracts/ogidOperations.js';
import { physicalPages } from "./sqlNewsCorpus.js";
import {
  permittedArticle,
  safeUrl,
  publicProjection,
} from "../utils/researchProjection.js";
import {
  classifyThreat,
  extractTopicTags,
} from "../services/news/rssClassifier.js";
import { AWARENESS_SOURCES } from "../services/awareness/awarenessCatalog.js";
import {
  assertPublication,
  evidencePublicationCode,
  normalizePublicationEvidence,
  agentError,
  TASKS,
  PROMPT_VERSION,
  validateEvidence,
} from "../services/agent/contracts.js";

const json = JSON.stringify,
  parse = JSON.parse;
const hash = (v) => createHash("sha256").update(v).digest("hex");
const active = [
  "queued",
  "waiting-model",
  "running",
  "validating",
  "incomplete",
];
const stamp = (ms) => new Date(ms).toISOString();
const pageLimit = (v) => Math.max(1, Math.min(100, Number(v) || 20));
// Stay below OpenCode's tool-output replacement threshold. These are transport
// pages, not evidence limits: cursors and hashed chunks retain the entire item.
const TOOL_PAGE_BYTES = 24 * 1024;
const INLINE_EVIDENCE_BYTES = 12 * 1024;
const safeId = (v) =>
  typeof v === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(v);
const admitted = (id) =>
  AWARENESS_SOURCES.find((s) => s.sourceId === id)?.admissionState === "active";
export const AGENT_READER_METHODS = new Set(["evidence","evidenceChunk","clusters","memory",
  "runControl","analysisList","analysisDetail","analysisSections","analysisSnapshotAccess","messages","deviceAuth","run","status","publications","sessions","workerHealth","sessionAccess","alerts","alertRevisions"]);
export const AGENT_METHODS = [
  "runControl", "analysisRequest", "analysisList", "analysisDetail", "analysisSections", "analysisSnapshotAccess",
  "sessionAccess",
  "progress",
  "status",
  "deviceCreate",
  "deviceAuth",
  "deviceRevoke",
  "sessions",
  "sessionCreate",
  "messages",
  "send", "requestAgent",
  "link",
  "enqueue",
  "consume",
  "claim",
  "heartbeat",
  "state",
  "snapshot",
  "evidence",
  "evidenceChunk",
  "clusters",
  "publish",
  "publications",
  "alerts",
  "alertState",
  "alertRevisions",
  "alertSync",
  "run",
  "cancel",
  "memory",
  "reconcileCandidates",
  "expireLeases",
  "resume",
  "control",
  "workerReport",
  "workerHealth",
  "pendingCancellations",
  "cancelAcknowledged",
  "interruptClaim",
];
export class AgentRepository {
  constructor(runtime, { now = Date.now, debounceMs = 30000, random = Math.random } = {}) {
    Object.assign(this, { runtime, db: runtime.db, now, debounceMs, random });
  }
  requestAgent(input){return requestAgent(this,input);}
  analysisRequest(input){return requestAnalysis(this,input,input.model);}
  analysisList(input){return readAnalyses(this,input);}
  analysisDetail(input){return readAnalyses(this,input);}
  analysisSections(input){return readAnalyses(this,input);}
  analysisSnapshotAccess({snapshotId}){const session=this.db.prepare('SELECT session_id sessionId FROM agent_jobs WHERE snapshot_id=? AND session_id IS NOT NULL').get(snapshotId);return {sessionId:session?.sessionId,restricted:Boolean(session)||this.snapshotInfo(snapshotId).coverage.situationId!==undefined};}

  recovery(model) {
    return (this.runtime.load('agent-recovery-v1')||[]).find(e=>e.model===model&&e.contractHash===OPERATIONS_HASH)||{model,contractHash:OPERATIONS_HASH,consecutiveFailures:0};
  }
  saveRecovery(model, value) {
    const entries=(this.runtime.load('agent-recovery-v1')||[]).filter(e=>!(e.model===model&&e.contractHash===OPERATIONS_HASH));
    entries.push({...value,model,contractHash:OPERATIONS_HASH});
    this.runtime.save('agent-recovery-v1',entries.slice(-16));
  }
  recordRecovery(job,input) {
    const m=input.metadata||{};
    const causeCode=m.terminalError?.causeCode || (m.lastToolFailure?.code==='INVALID_ARGUMENTS'?'MCP_INVALID_ARGUMENTS':null);
    this.saveRecovery(job.model,recoveryAfter(this.recovery(job.model),{status:input.status,causeCode,jobId:job.job_id,fence:input.fence,now:this.now(),random:this.random}));
  }
  call(method, input = {}) {
    if (!AGENT_METHODS.includes(method))
      throw agentError("AGENT_UNKNOWN_OPERATION");
    return this[method](input);
  }
  control({ paused, backgroundModel } = {}) {
    const saved = this.runtime.load("agent-control") || { paused: false };
    if (paused === undefined && backgroundModel === undefined) return saved;
    if ((paused !== undefined && typeof paused !== "boolean") || (backgroundModel !== undefined && !/^llamacpp\/[A-Za-z0-9._:-]{1,160}$/.test(backgroundModel)))
      throw agentError("AGENT_INVALID_ARGUMENTS");
    return this.db.transaction(()=>{
      const requeued=0;
      const next={...saved,...(paused===undefined?{}:{paused}),...(backgroundModel===undefined?{}:{backgroundModel})};
      this.runtime.save("agent-control",next);
      return {...next,...(backgroundModel===undefined?{}:{requeued})};
    }).immediate();
  }
  status({since=null}={}) {
    return this.db.transaction(()=>this.statusView({since})).deferred();
  }
  statusView({since=null}={}) {
    const validSince=typeof since==='string' && Number.isFinite(Date.parse(since)) ? since : stamp(this.now());
    const columns="job_id AS jobId,task,scope,model,status,error_code AS errorCode,created_at AS createdAt,updated_at AS updatedAt,lease_until AS leaseUntil,fence,attempts,snapshot_id AS snapshotId";
    const recentJobs=this.db.prepare(`SELECT ${columns} FROM agent_jobs INDEXED BY agent_jobs_active_recent WHERE status IN ('running','waiting-model','validating') ORDER BY updated_at DESC,job_id LIMIT 50`).all();
    if(recentJobs.length<50)recentJobs.push(...this.db.prepare(`SELECT ${columns} FROM agent_jobs INDEXED BY agent_jobs_inactive_recent WHERE status NOT IN ('running','waiting-model','validating') ORDER BY updated_at DESC,job_id LIMIT ?`).all(50-recentJobs.length));
    const current=this.db.prepare("SELECT count(*) AS executions,coalesce(sum(status='completed'),0) AS completed,coalesce(sum(status='failed'),0) AS failed,coalesce(sum(status IN ('running','waiting-model','validating')),0) AS active,coalesce(sum(json_extract(metadata_json,'$.validation.candidateAttempts')),0) AS candidates,coalesce(sum(json_extract(metadata_json,'$.validation.repairAttempted')=1),0) AS repairs,coalesce(sum(json_extract(metadata_json,'$.evidenceReads')>0),0) AS evidenceReads,coalesce(sum(json_type(metadata_json,'$.evidenceReads') IS NULL),0) AS evidenceReadUnknown,max(CASE WHEN status='completed' THEN finished_at END) AS lastSuccessAt,max(CASE WHEN status='failed' THEN finished_at END) AS lastFailureAt FROM agent_runs WHERE started_at>=?").get(validSince);
    current.publications=this.db.prepare('SELECT count(*) AS n FROM agent_publications WHERE published_at>=?').get(validSince).n;
    current.failures=this.db.prepare("SELECT coalesce(json_extract(metadata_json,'$.terminalError.causeCode'),CASE WHEN json_extract(metadata_json,'$.lastToolFailure.code')='INVALID_ARGUMENTS' THEN 'MCP_INVALID_ARGUMENTS' END,json_extract(metadata_json,'$.errorCode'),'UNKNOWN') AS causeCode,count(*) AS count FROM agent_runs WHERE started_at>=? AND status='failed' GROUP BY causeCode ORDER BY count DESC LIMIT 16").all(validSince);
    const result = {
      sampledAt:stamp(this.now()),
      since:validSince,
      current,
      recovery:(this.runtime.load('agent-recovery-v1')||[]).filter(e=>e.contractHash===OPERATIONS_HASH),
      sinceCounts:this.db.prepare('SELECT status,count(*) AS count FROM agent_runs WHERE started_at>=? GROUP BY status').all(validSince),
      proposalMetrics:summarizeProposals(this.db.prepare("SELECT j.task,j.model,json_extract(r.metadata_json,'$.validation') AS validation FROM (SELECT job_id,metadata_json FROM agent_runs WHERE started_at>=? ORDER BY started_at DESC LIMIT 1001) r JOIN agent_jobs j ON j.job_id=r.job_id").all(validSince),{since:validSince}),
      queueAge:this.db.prepare("SELECT min(created_at) AS oldestQueuedAt FROM agent_jobs WHERE status='queued'").get(),
      recentJobs,
      publicationCount:this.db.prepare('SELECT count(*) AS count FROM agent_publications').get().count,
      recentPublications:this.db.prepare(`SELECT mode,CASE WHEN length(CAST(payload_json AS BLOB))<=65536 THEN payload_json ELSE json_object('publicationId',publication_id,'jobId',job_id,'snapshotId',snapshot_id,'publishedAt',published_at,'truncated',json('true'),'proposal',json_object('task',task,'summary','Respuesta archivada; cuerpo omitido por límite del diagnóstico.')) END AS payload_json FROM agent_publications ORDER BY published_at DESC,rowid DESC LIMIT 5`).all().map(({mode,payload_json})=>({mode,...parse(payload_json)})),
      workerHealth: this.workerHealth(),
      runs: this.db
        .prepare(
          "SELECT r.run_id AS runId,r.job_id AS jobId,r.fence,r.started_at AS startedAt,r.finished_at AS finishedAt,r.status,CASE WHEN length(CAST(r.metadata_json AS BLOB))<=32768 THEN r.metadata_json ELSE json_object('truncated',json('true'),'phase',json_extract(r.metadata_json,'$.phase'),'errorCode',json_extract(r.metadata_json,'$.errorCode'),'toolsCompleted',json_extract(r.metadata_json,'$.toolsCompleted'),'evidenceReads',json_extract(r.metadata_json,'$.evidenceReads')) END AS metadata_json FROM agent_runs r JOIN agent_jobs j ON j.job_id=r.job_id AND j.fence=r.fence WHERE j.job_id IN (SELECT value FROM json_each(?)) ORDER BY r.started_at DESC LIMIT 50",
        )
        .all(json(recentJobs.map(j=>j.jobId)))
        .map(({ metadata_json, ...r }) => ({
          ...r,
          metadata: parse(metadata_json),
        })),
      jobs: this.db
        .prepare(
          "SELECT status,count(*) AS count FROM agent_jobs GROUP BY status",
        )
        .all(),
      latest: this.db
        .prepare(
          "SELECT max(published_at) AS publishedAt FROM agent_publications",
        )
        .get(),
      devices: this.db
        .prepare(
          "SELECT device_id AS deviceId,label,created_at AS createdAt,revoked_at AS revokedAt FROM agent_devices ORDER BY created_at DESC LIMIT 100",
        )
        .all(),
    };
    result.limits={jobs:50,issues:16,maxBytes:1048576};
    while(Buffer.byteLength(json(result))>1048576){
      result.truncated=true;
      const publication=result.recentPublications.find(p=>!p.truncated);
      if(publication){publication.truncated=true;publication.proposal={task:publication.proposal?.task,summary:'Cuerpo omitido por límite del diagnóstico.'};continue;}
      const run=result.runs.find(r=>!r.metadata.truncated);
      if(run){run.metadata={truncated:true,phase:run.metadata.phase,errorCode:run.metadata.errorCode};continue;}
      break;
    }
    return result;
  }
  workerReport({
    owner,
    model,
    active = 0,
    errorCode = null,
    verifiedAt = null,
  }) {
    if (
      !safeId(owner) ||
      typeof model !== "string" ||
      !Number.isSafeInteger(active) ||
      active < 0 ||
      active > 2 ||
      (errorCode !== null && !/^[A-Z0-9_]{1,100}$/.test(errorCode)) ||
      (verifiedAt !== null && !Number.isFinite(Date.parse(verifiedAt)))
    )
      throw agentError("AGENT_INVALID_TELEMETRY");
    this.runtime.save("agent-worker-health", {
      owner,
      model,
      active,
      errorCode,
      verifiedAt,
      reportedAt: stamp(this.now()),
    });
    return { accepted: true, recovery:this.recovery(model) };
  }
  workerHealth() {
    const value = this.runtime.load("agent-worker-health");
    return value
      ? {
          ...value,
          state:
            this.now() - Date.parse(value.reportedAt) > 90000
              ? "stale"
              : value.errorCode
                ? "degraded"
                : "connected",
          scope:
            "OpenCode and MCP control plane; inference health is reflected in runs",
        }
      : { state: "unavailable" };
  }
  deviceCreate({ label = "Personal" }) {
    if (typeof label !== "string" || !label.trim() || label.length > 100)
      throw agentError("AGENT_INVALID_DEVICE");
    const deviceId = randomUUID(),
      token = randomBytes(32).toString("base64url"),
      csrf = randomBytes(24).toString("base64url");
    this.db
      .prepare("INSERT INTO agent_devices VALUES(?,?,?,?,?,NULL)")
      .run(deviceId, hash(token), csrf, label, stamp(this.now()));
    return { deviceId, token, csrf };
  }
  deviceAuth({ token }) {
    if (typeof token !== "string" || token.length > 256) return null;
    const r = this.db
      .prepare(
        "SELECT device_id AS deviceId,csrf FROM agent_devices WHERE token_hash=? AND revoked_at IS NULL",
      )
      .get(hash(token));
    return r || null;
  }
  deviceRevoke({ deviceId }) {
    this.db
      .prepare("UPDATE agent_devices SET revoked_at=? WHERE device_id=?")
      .run(stamp(this.now()), deviceId);
    return { revoked: true };
  }
  owned(sessionId, deviceId) {
    const r = this.db
      .prepare(
        "SELECT * FROM agent_sessions WHERE session_id=? AND device_id=? AND EXISTS(SELECT 1 FROM agent_devices WHERE device_id=? AND revoked_at IS NULL)",
      )
      .get(sessionId, deviceId, deviceId);
    if (!r) throw agentError("AGENT_SESSION_NOT_FOUND", 404);
    return r;
  }
  sessionAccess({sessionId,deviceId}) {
    this.owned(sessionId,deviceId);
    return {authorized:true};
  }
  sessions({ deviceId, cursor = 0, limit = 20 }) {
    const rows = this.db
        .prepare(
          "SELECT rowid AS seq,session_id AS sessionId,model,title,created_at AS createdAt FROM agent_sessions WHERE device_id=? AND (?=0 OR rowid<?) ORDER BY rowid DESC LIMIT ?",
        )
        .all(
          deviceId,
          Number(cursor) || 0,
          Number(cursor) || 0,
          pageLimit(limit) + 1,
        ),
      hasMore = rows.length > pageLimit(limit);
    if (hasMore) rows.pop();
    return {
      items: rows.map(({ seq, ...r }) => r),
      hasMore,
      nextCursor: hasMore ? String(rows.at(-1).seq) : null,
    };
  }
  sessionCreate({ deviceId, model, title = "Nueva conversación" }) {
    if (
      !safeId(model?.replaceAll("/", ":")) ||
      typeof title !== "string" ||
      title.length > 160
    )
      throw agentError("AGENT_INVALID_SESSION");
    const sessionId = randomUUID();
    this.db
      .prepare("INSERT INTO agent_sessions VALUES(?,?,?,?,?,NULL)")
      .run(sessionId, deviceId, model, title, stamp(this.now()));
    return { sessionId, model, title };
  }
  messages({
    sessionId,
    deviceId,
    cursor = 0,
    limit = 20,
    latest = false,
    before = 0,
  }) {
    this.owned(sessionId, deviceId);
    const backwards = latest || Number(before) > 0,
      n = Number(before) || Number.MAX_SAFE_INTEGER;
    const rows = this.db
      .prepare(
        backwards
          ? "SELECT rowid AS seq,* FROM agent_messages WHERE session_id=? AND rowid<? ORDER BY rowid DESC LIMIT ?"
          : "SELECT rowid AS seq,* FROM agent_messages WHERE session_id=? AND rowid>? ORDER BY rowid LIMIT ?",
      )
      .all(
        sessionId,
        backwards ? n : Number(cursor) || 0,
        pageLimit(limit) + 1,
      );
    const hasMore = rows.length > pageLimit(limit);
    if (hasMore) rows.pop();
    if (backwards) rows.reverse();
    return {
      items: rows.map((r) => ({
        sequence: r.seq,
        messageId: r.message_id,
        role: r.role,
        createdAt: r.created_at,
        ...parse(r.payload_json),
      })),
      hasMore,
      nextCursor: rows.at(-1)?.seq || cursor,
      olderCursor: backwards && hasMore ? rows[0].seq : null,
      activeRun:
        this.db
          .prepare(
            "SELECT job_id AS jobId,status,error_code AS errorCode FROM agent_jobs WHERE session_id=? AND (status IN ('queued','running','waiting-model','validating') OR (status='incomplete' AND opencode_id IS NOT NULL AND coalesce(json_extract(input_json,'$.interruptAcknowledged'),0)=0)) ORDER BY CASE WHEN status='queued' THEN 1 ELSE 0 END,created_at LIMIT 1",
          )
          .get(sessionId) || null,
    };
  }
  send({ sessionId, deviceId, key, text, context = [], appContext = {} }) {
    this.owned(sessionId, deviceId);
    if (
      !safeId(key) ||
      typeof text !== "string" ||
      !text.trim() ||
      Buffer.byteLength(text) > 524288 ||
      !Array.isArray(context) ||
      context.length > 20 ||
      context.some((x) => !safeId(x))
    )
      throw agentError("AGENT_INVALID_MESSAGE");
    const descriptor=validateContext(appContext);
    return this.db
      .transaction(() => {
        const old = this.db
          .prepare(
            "SELECT * FROM agent_messages WHERE session_id=? AND idempotency_key=?",
          )
          .get(sessionId, key);
        if (old) {
          if (
            stableHash({...parse(old.payload_json),appContext:parse(old.payload_json).appContext||{view:"dashboard",countries:[],instrumentIds:[]}}) !==
            stableHash({ text, context,appContext:descriptor })
          )
            throw agentError("AGENT_IDEMPOTENCY_CONFLICT", 409);
          return {
            messageId: old.message_id,
            jobId: this.db
              .prepare("SELECT job_id FROM agent_jobs WHERE message_id=?")
              .get(old.message_id)?.job_id,
            replayed: true,
          };
        }
        const session = this.owned(sessionId, deviceId),
          messageId = randomUUID();
        this.db
          .prepare("INSERT INTO agent_messages VALUES(?,?,?,?,?,?)")
          .run(
            messageId,
            sessionId,
            "user",
            stamp(this.now()),
            json({ text, context,appContext:descriptor }),
            key,
          );
        const job = this.enqueue({
          task: "contextual_chat",
          scope: sessionId,
          model: session.model,
          key: `chat:${messageId}`,
          sessionId,
          messageId,
          input: { origin:"user",text, context: this.resolveContext(context,deviceId),appContext:captureContext(this,descriptor) },
          priority: 10,
        });
        return { messageId, jobId: job.jobId };
      })
      .immediate();
  }
  resolveContext(ids,deviceId) {
    return ids.map((id) => {
      const pub = this.db
        .prepare(
          "SELECT p.payload_json,s.device_id FROM agent_publications p JOIN agent_jobs j ON j.job_id=p.job_id LEFT JOIN agent_sessions s ON s.session_id=j.session_id WHERE p.publication_id=?",
        )
        .get(id);
      if(pub?.device_id&&pub.device_id!==deviceId)throw agentError('AGENT_INVALID_CONTEXT');
      if(pub&&parse(pub.payload_json).proposal?.task==='situation_analysis')throw agentError('AGENT_INVALID_CONTEXT');
      if (pub)
        return {
          kind: "publication",
          id,
          derived: true,
          data: parse(pub.payload_json),
        };
      const alert = this.db
        .prepare(
          "SELECT payload_json FROM geopolitical_alerts WHERE alert_id=?",
        )
        .get(id);
      if (alert) return { kind: "alert", id, data: parse(alert.payload_json) };
      const instrument = this.db
        .prepare("SELECT metadata_json FROM instruments WHERE instrument_id=?")
        .get(id);
      if (instrument)
        return {
          kind: "instrument",
          id,
          data: parse(instrument.metadata_json),
        };
      throw agentError("AGENT_CONTEXT_NOT_FOUND", 404);
    });
  }
  enqueue({
    task,
    scope = "global",
    model,
    key,
    sessionId = null,
    messageId = null,
    input = {},
    priority = 50,
  }) {
    if (
      !TASKS.includes(task) ||
      !safeId(scope) ||
      typeof model !== "string" ||
      !model.startsWith("llamacpp/") ||
      !key
    )
      throw agentError("AGENT_INVALID_JOB");
    const old = this.db
      .prepare("SELECT job_id AS jobId FROM agent_jobs WHERE idempotency_key=?")
      .get(key);
    if (old) return old;
    if (
      this.db
        .prepare(
          "SELECT count(*) AS n FROM agent_jobs WHERE status IN ('queued','waiting-model','running','validating')",
        )
        .get().n >= 128
    )
      throw agentError("AGENT_BACKPRESSURE", 503);
    const jobId = randomUUID(),
      at = stamp(this.now());
    this.db
      .prepare(
        "INSERT INTO agent_jobs(job_id,task,scope,model,prompt_version,idempotency_key,session_id,message_id,status,priority,created_at,updated_at,input_json) VALUES(?,?,?,?,?,?,?,?,'queued',?,?,?,?)",
      )
      .run(
        jobId,
        task,
        scope,
        model,
        PROMPT_VERSION,
        key,
        sessionId,
        messageId,
        priority,
        at,
        at,
        json(input),
      );
    return { jobId };
  }
  consume({model}={}) {
    // Compatibility endpoint: outbox changes never create inference work.
    return {jobs:[],hasMore:false,model,onDemand:true};
  }
  job(id) {
    const r = this.db
      .prepare("SELECT * FROM agent_jobs WHERE job_id=?")
      .get(id);
    if (!r) throw agentError("AGENT_RUN_NOT_FOUND", 404);
    return r;
  }
  wire(r) {
    return {
      jobId: r.job_id,
      runId: `${r.job_id}:${r.fence}`,
      task: r.task,
      scope: r.scope,
      model: r.model,
      promptVersion: r.prompt_version,
      status: r.status,
      fence: r.fence,
      snapshotId: r.snapshot_id,
      sessionId: r.session_id,
      opencodeId:
        r.opencode_id ||
        (r.session_id
          ? this.db
              .prepare(
                "SELECT opencode_id FROM agent_sessions WHERE session_id=?",
              )
              .get(r.session_id)?.opencode_id
          : null),
      messageId: r.message_id,
      input: parse(r.input_json),
      errorCode: r.error_code,
      createdAt: r.created_at,
    };
  }
  claim({ owner, enabledTasks = TASKS }) {
    if (!safeId(owner)) throw agentError("AGENT_INVALID_OWNER");
    return this.db
      .transaction(() => {
        // A crashed/in-doubt attempt is reconciled; never replay its POST blindly.
        this.db.prepare("UPDATE agent_jobs SET status='cancelled',error_code='AGENT_AUTOMATION_DISABLED',updated_at=? WHERE status IN ('queued','waiting-model') AND lease_owner IS NULL AND session_id IS NULL AND json_extract(input_json,'$.outboxSequence') IS NOT NULL").run(stamp(this.now()));
        this.db.prepare("UPDATE agent_jobs SET status='superseded',error_code='AGENT_PROMPT_UPDATED',updated_at=? WHERE status IN ('queued','waiting-model') AND lease_owner IS NULL AND prompt_version!=?").run(stamp(this.now()),PROMPT_VERSION);
        this.expireLeases();
        if(this.db.prepare("SELECT 1 FROM agent_jobs WHERE (status IN ('running','validating','waiting-model') AND lease_owner IS NOT NULL) OR (opencode_id IS NOT NULL AND status IN ('incomplete','cancelled') AND coalesce(json_extract(input_json,'$.interruptAcknowledged'),json_extract(input_json,'$.cancellationAcknowledged'),0)=0) LIMIT 1").get())return null;
        const candidates = this.db
          .prepare(
            "SELECT * FROM agent_jobs WHERE (status='queued' OR (status='waiting-model' AND lease_owner IS NULL)) AND task IN (SELECT value FROM json_each(?)) AND attempts<3 AND (priority<20 OR created_at<=?) AND (session_id IS NULL OR NOT EXISTS(SELECT 1 FROM agent_jobs other WHERE other.session_id=agent_jobs.session_id AND (other.status IN ('running','validating','waiting-model') OR (other.opencode_id IS NOT NULL AND ((other.status='cancelled' AND coalesce(json_extract(other.input_json,'$.cancellationAcknowledged'),0)=0) OR (other.status='incomplete' AND coalesce(json_extract(other.input_json,'$.interruptAcknowledged'),0)=0)))))) ORDER BY priority - ((?-julianday(created_at))*24*60),created_at LIMIT 128",
          )
          .all(
            json(enabledTasks),
            stamp(this.now() - this.debounceMs),
            this.now() / 86400000 + 2440587.5,
          );
        const recoveryEntries=this.runtime.load('agent-recovery-v1')||[];
        const r = candidates.find(candidate=>{
          const recovery=recoveryEntries.find(e=>e.model===candidate.model&&e.contractHash===OPERATIONS_HASH)||{};
          if(recovery.nextEligibleAt && Date.parse(recovery.nextEligibleAt)>this.now())return false;
          if(recovery.probe){const probe=this.db.prepare('SELECT status FROM agent_jobs WHERE job_id=?').get(recovery.probe.jobId);if(probe && ['running','validating','waiting-model','incomplete'].includes(probe.status))return false;}
          return true;
        });
        this.db
          .prepare(
            "UPDATE agent_runs SET status='incomplete',finished_at=? WHERE finished_at IS NULL AND EXISTS(SELECT 1 FROM agent_jobs j WHERE j.job_id=agent_runs.job_id AND j.fence=agent_runs.fence AND j.status='incomplete')",
          )
          .run(stamp(this.now()));
        if (!r) return null;
        this.db
          .prepare(
            "UPDATE agent_jobs SET status='running',lease_owner=?,lease_until=?,fence=fence+1,attempts=attempts+1,updated_at=? WHERE job_id=?",
          )
          .run(owner, this.now() + AGENT_POLICY.leaseMs, stamp(this.now()), r.job_id);
        const job = this.job(r.job_id);
        const recovery=this.recovery(job.model);
        if(recovery.nextEligibleAt)this.saveRecovery(job.model,{...recovery,probe:{jobId:job.job_id,fence:job.fence}});
        this.db
          .prepare("INSERT INTO agent_runs VALUES(?,?,?,?,NULL,?,?)")
          .run(
            `${job.job_id}:${job.fence}`,
            job.job_id,
            job.fence,
            stamp(this.now()),
            "running",
            json({ model: job.model, promptVersion: job.prompt_version }),
          );
        return this.wire(job);
      })
      .immediate();
  }
  fenced({ jobId, owner, fence }) {
    const r = this.job(jobId);
    if (
      r.lease_owner !== owner ||
      r.fence !== fence ||
      r.lease_until <= this.now() ||
      !["running", "validating", "waiting-model"].includes(r.status)
    )
      throw agentError("AGENT_LEASE_LOST", 409);
    return r;
  }
  reconcileCandidates() {
    return this.db
      .prepare(
        "SELECT * FROM agent_jobs WHERE status='incomplete' AND attempts<3 AND (json_extract(input_json,'$.interruptId') IS NULL OR json_extract(input_json,'$.interruptAcknowledged')=1) ORDER BY updated_at LIMIT 20",
      )
      .all()
      .map((r) => this.wire(r));
  }
  expireLeases() {
    // Deterministic reconciliation is also available with automatic IA off.
    // Do not claim, enqueue, replay a POST, or infer completion from expiry.
    return this.db.transaction(()=>{
      const at=this.now(),jobs=this.db.prepare("SELECT job_id,fence FROM agent_jobs WHERE status IN ('running','validating','waiting-model') AND lease_owner IS NOT NULL AND lease_until<=? LIMIT 128").all(at);
      for(const job of jobs){
        this.db.prepare("UPDATE agent_jobs SET status='incomplete',error_code='AGENT_LEASE_EXPIRED',updated_at=? WHERE job_id=? AND fence=?").run(stamp(at),job.job_id,job.fence);
        this.db.prepare("UPDATE agent_runs SET status='incomplete',finished_at=? WHERE job_id=? AND fence=? AND finished_at IS NULL").run(stamp(at),job.job_id,job.fence);
      }
      return {expired:jobs.length,hasMore:jobs.length===128};
    }).immediate();
  }
  pendingCancellations() {
    return this.db
      .prepare(
        "SELECT * FROM agent_jobs WHERE opencode_id IS NOT NULL AND ((status='cancelled' AND coalesce(json_extract(input_json,'$.cancellationAcknowledged'),0)=0) OR (status='incomplete' AND coalesce(json_extract(input_json,'$.interruptAcknowledged'),0)=0)) LIMIT 20",
      )
      .all()
      .map((r) => this.wire(r));
  }
  interruptClaim({ jobId, fence, owner }) {
    return this.db
      .transaction(() => {
        const r = this.job(jobId),
          input = parse(r.input_json);
        if (
          r.fence !== fence ||
          !safeId(owner) ||
          (input.interruptUntil > this.now() && !input.interruptAcknowledged)
        )
          return null;
        if (
          ![
            "running",
            "validating",
            "waiting-model",
            "cancelled",
            "incomplete",
          ].includes(r.status) ||
          (["running", "validating", "waiting-model"].includes(r.status) &&
            (r.lease_owner !== owner || r.lease_until <= this.now()))
        )
          return null;
        const interruptId = randomUUID();
        this.db
          .prepare(
            "UPDATE agent_jobs SET input_json=json_set(input_json,'$.interruptId',?,'$.interruptUntil',?,'$.interruptAcknowledged',json('false')) WHERE job_id=?",
          )
          .run(interruptId, this.now() + 30000, jobId);
        return { interruptId };
      })
      .immediate();
  }
  cancelAcknowledged({ jobId, fence, interruptId,resolution }) {
    const r = this.job(jobId);
    if (r.fence !== fence || parse(r.input_json).interruptId !== interruptId)
      throw agentError("AGENT_LEASE_LOST", 409);
    this.db
      .prepare(
        "UPDATE agent_jobs SET input_json=json_set(input_json,'$.cancellationAcknowledged',json('true'),'$.interruptAcknowledged',json('true'),'$.interruptionResolution',json(?)) WHERE job_id=?",
      )
      .run(json(resolution?.state==='absent'?{state:'absent',observedAt:stamp(this.now()),originalOutcome:'unknown'}:{state:'interrupt-acknowledged'}),jobId);
    return { acknowledged: true };
  }
  resume({ jobId }) {
    const row = this.job(jobId);
    const interruption = parse(row.input_json);
    if (interruption.interruptId && !interruption.interruptAcknowledged)
      throw agentError("AGENT_RECONCILIATION_DENIED", 409);
    // A prompt is never submitted before its session link is committed. An
    // unlinked attempt can safely rebuild its snapshot/session under a new fence.
    if (row.status !== "incomplete" || row.attempts >= 3)
      throw agentError("AGENT_RECONCILIATION_DENIED", 409);
    if(row.prompt_version!==PROMPT_VERSION){
      if(row.opencode_id&&!interruption.interruptAcknowledged)throw agentError("AGENT_RECONCILIATION_DENIED",409);
      this.db.prepare("UPDATE agent_jobs SET status='superseded',updated_at=?,error_code='AGENT_PROMPT_UPDATED' WHERE job_id=?").run(stamp(this.now()),row.job_id);
      return {superseded:true};
    }
    this.db
      .prepare(
        "UPDATE agent_jobs SET status='queued',lease_owner=NULL,lease_until=NULL,error_code=NULL WHERE job_id=? AND status='incomplete'",
      )
      .run(jobId);
    return { resumed: true };
  }
  heartbeat(input) {
    return this.db.transaction(()=>{
      const job = this.job(input.jobId);
      if (job.lease_owner !== input.owner || job.fence !== input.fence)
        throw agentError("AGENT_LEASE_LOST", 409);
      if (job.status === "completed") {
        const run = this.db.prepare("SELECT finished_at FROM agent_runs WHERE job_id=? AND fence=? AND status='completed'").get(input.jobId, input.fence);
        const publication = job.task === "contextual_chat" || this.db.prepare("SELECT 1 FROM agent_publications WHERE job_id=? AND snapshot_id=?").get(input.jobId, job.snapshot_id);
        if (run?.finished_at && publication) return { renewed: false, closed: true, status: "completed" };
      }
      const renewalId = input.renewalId;
      if (renewalId !== undefined && !safeId(renewalId)) throw agentError("AGENT_INVALID_OPERATION");
      const requestId = renewalId ? `heartbeat:${renewalId}` : null;
      const inputHash = stableHash([input.jobId, input.owner, input.fence, input.progress || null]);
      if (requestId) {
        const previous = this.db.prepare("SELECT * FROM storage_commands WHERE request_id=?").get(requestId);
        if (previous) {
          if (previous.operation !== "agent.heartbeat" || previous.input_hash !== inputHash)
            throw agentError("AGENT_IDEMPOTENCY_CONFLICT", 409);
          // A replay acknowledges the original lease; it cannot resurrect it.
          this.fenced(input);
          return { ...parse(previous.result_json), replayed: true };
        }
      }
      this.fenced(input);
      const leaseUntil = this.now() + AGENT_POLICY.leaseMs;
      this.db.prepare("UPDATE agent_jobs SET lease_until=? WHERE job_id=?").run(leaseUntil, input.jobId);
      if(input.progress && typeof input.progress==='object'){
        const p=input.progress,clean={};
        for(const key of ['elapsedMs','firstProgressMs','toolsCompleted','evidenceReads','outputCharacters'])if(Number.isFinite(p[key])&&p[key]>=0)clean[key]=p[key];
        if(['snapshot','inference','validating','repair'].includes(p.phase))clean.phase=p.phase;
        if(typeof p.lastProgressAt==='string' && Number.isFinite(Date.parse(p.lastProgressAt)))clean.lastProgressAt=p.lastProgressAt;
        if(p.lastToolFailure){
          const f=p.lastToolFailure;
          if(/^[A-Z_]{2,80}$/.test(f.code||''))clean.lastToolFailure={code:f.code,operationId:/^[a-zA-Z0-9.]{1,128}$/.test(f.operationId||'')?f.operationId:null,callId:safeId(f.callId)?f.callId:null,validation:f.validation?{stage:String(f.validation.stage||'unknown').slice(0,64),issues:(Array.isArray(f.validation.issues)?f.validation.issues:[]).slice(0,16).map(i=>({path:(Array.isArray(i.path)?i.path:[]).slice(0,16).map(p=>String(p).slice(0,64)),code:String(i.code||'unknown').slice(0,64),expected:typeof i.expected==='string'?i.expected.slice(0,64):null}))}:null};
        }
        if(typeof p.mcpContractHash==='string'&&/^[a-f0-9]{64}$/.test(p.mcpContractHash))clean.mcpContractHash=p.mcpContractHash;
        this.db.prepare("UPDATE agent_runs SET metadata_json=json_patch(metadata_json,?) WHERE job_id=? AND fence=?").run(json(clean),input.jobId,input.fence);
      }
      const result = { renewed: true, leaseUntil };
      if (requestId) this.db.prepare("INSERT INTO storage_commands VALUES(?,?,?,?,?)").run(requestId, "agent.heartbeat", inputHash, json(result), stamp(this.now()));
      return result;
    }).immediate();
  }
  progress(input) {
    const job=this.job(input.jobId);
    if(job.lease_owner!==input.owner || job.fence!==input.fence)throw agentError('AGENT_LEASE_LOST',409);
    // A terminal notification only requests durable reconciliation. Text/tool
    // updates still require the active, unexpired lease.
    if(!(input.done===true && ['completed','failed','incomplete','cancelled','superseded'].includes(job.status)))this.fenced(input);
    return {sessionId:job.session_id};
  }
  link(input) {
    return this.db.transaction(()=>{
      const r=this.fenced(input);
      if(!safeId(input.opencodeId))throw agentError('AGENT_INVALID_LINK');
      if(input.generation){
        const g=input.generation,key=stableHash([r.job_id,input.fence,r.snapshot_id,r.model,r.prompt_version,g.inputHash]);
        if(g.key!==key||g.snapshotId!==r.snapshot_id||g.fence!==input.fence||g.model!==r.model||g.promptVersion!==r.prompt_version||!safeId(g.messageId)||!safeId(g.sessionId)||g.sessionId!==input.opencodeId||!/^[a-f0-9]{64}$/.test(g.inputHash||''))throw agentError('AGENT_INVALID_GENERATION');
        const run=this.db.prepare('SELECT metadata_json FROM agent_runs WHERE job_id=? AND fence=?').get(r.job_id,input.fence);
        const previous=run?parse(run.metadata_json).generation:null;
        if(previous&&stableHash(previous)!==stableHash(g))throw agentError('AGENT_GENERATION_CONFLICT',409);
        this.db.prepare('UPDATE agent_runs SET metadata_json=json_patch(metadata_json,?) WHERE job_id=? AND fence=?').run(json({generation:g}),r.job_id,input.fence);
        if(input.message){
          const m=input.message;
          if(!['initial','repair'].includes(m.kind)||m.id!==(m.kind==='initial'?g.messageId:g.repairMessageId)||!/^[a-f0-9]{64}$/.test(m.hash||''))throw agentError('AGENT_INVALID_GENERATION');
          const messages=run?parse(run.metadata_json).generationMessages||[]:[];
          if(messages.some(old=>old.id===m.id&&old.hash!==m.hash))throw agentError('AGENT_GENERATION_CONFLICT',409);
          if(!messages.some(old=>old.id===m.id))messages.push({id:m.id,kind:m.kind,hash:m.hash});
          this.db.prepare('UPDATE agent_runs SET metadata_json=json_patch(metadata_json,?) WHERE job_id=? AND fence=?').run(json({generationMessages:messages}),r.job_id,input.fence);
        }
      }
      this.db.prepare('UPDATE agent_jobs SET opencode_id=? WHERE job_id=?').run(input.opencodeId,r.job_id);
      if(r.session_id&&r.task==='contextual_chat')this.db.prepare('UPDATE agent_sessions SET opencode_id=? WHERE session_id=?').run(input.opencodeId,r.session_id);
      return {linked:true};
    }).immediate();
  }
  state(input) {
    this.fenced(input);
    if (
      ![
        "running",
        "validating",
        "waiting-model",
        "failed",
        "incomplete",
        "completed",
      ].includes(input.status)
    )
      throw agentError("AGENT_INVALID_STATE");
    if (
      input.status === "completed" &&
      this.job(input.jobId).task !== "contextual_chat"
    )
      throw agentError("AGENT_PUBLICATION_REQUIRED");
    return this.db
      .transaction(() => {
        const job = this.job(input.jobId);
        if (input.status === "completed") {
          if (
            typeof input.text !== "string" ||
            Buffer.byteLength(input.text) > 8388608
          )
            throw agentError("AGENT_INVALID_MESSAGE");
          const evidenceIds = [
            ...new Set(
              [
                ...input.text.matchAll(
                  /\[evidence:([A-Za-z0-9._:-]{1,240})\]/g,
                ),
              ].map((m) => m[1]),
            ),
          ];
          if (!evidenceIds.length)
            throw agentError("AGENT_CHAT_CITATION_REQUIRED");
          const unknownEvidenceId=evidenceIds.find(
              (id) =>
                !this.db
                  .prepare(
                    "SELECT 1 FROM agent_evidence WHERE snapshot_id=? AND evidence_id=?",
                  )
                  .get(job.snapshot_id, id),
            );
          if(unknownEvidenceId)
            throw agentError("AGENT_UNKNOWN_EVIDENCE",400,{evidenceId:unknownEvidenceId,reason:'not-in-snapshot'});
          this.fenced(input);
          this.db
            .prepare(
              "INSERT OR IGNORE INTO agent_messages VALUES(?,?,?,?,?,NULL)",
            )
            .run(
              `answer:${job.message_id}`,
              job.session_id,
              "assistant",
              stamp(this.now()),
              json({
                text: input.text,
                jobId: job.job_id,
                snapshotId: job.snapshot_id,
                evidenceIds,
              }),
            );
        }
        this.fenced(input);
        this.db
          .prepare(
            "UPDATE agent_jobs SET status=?,error_code=?,updated_at=? WHERE job_id=?",
          )
          .run(
            input.status,
            input.errorCode || null,
            stamp(this.now()),
            input.jobId,
          );
        this.db
          .prepare(
            "UPDATE agent_runs SET status=?,finished_at=?,metadata_json=json_patch(metadata_json,?) WHERE job_id=? AND fence=?",
          )
          .run(
            input.status,
            ["running", "validating", "waiting-model"].includes(input.status)
              ? null
              : stamp(this.now()),
            json(publicProjection({...input.metadata,errorCode:input.errorCode || null})),
            input.jobId,
            input.fence,
          );
        if(["completed","failed","incomplete"].includes(input.status))this.recordRecovery(job,input);
        return { status: input.status };
      })
      .immediate();
  }
  snapshot(input) {
    const prepared=this.prepareSnapshot(input);
    if(prepared.existing)return prepared.existing;
    return this.db.transaction(()=>{
      this.snapshotWrite({...input,phase:"begin",prepared:{...prepared,rows:undefined},counts:Object.fromEntries(Object.entries(prepared.rows).map(([table,rows])=>[table,rows.length]))});
      let page=0;
      for(const [table,rows]of Object.entries(prepared.rows))for(let offset=0;offset<rows.length;offset+=100)this.snapshotWrite({...input,phase:"page",snapshotId:prepared.snapshotId,table,page:page++,rows:rows.slice(offset,offset+100)});
      return this.snapshotWrite({...input,phase:"seal",snapshotId:prepared.snapshotId,page});
    }).immediate();
  }
  snapshotWrite(input) {
    return this.db.transaction(()=>{
      const job=this.fenced(input);
      if(input.phase==='cleanup'){
        const abandoned=this.db.prepare("SELECT snapshot_id FROM agent_snapshots s WHERE json_extract(manifest_json,'$.sealed')=0 AND json_extract(manifest_json,'$.building.jobId')=? AND NOT EXISTS(SELECT 1 FROM agent_jobs j WHERE j.snapshot_id=s.snapshot_id) ORDER BY as_of LIMIT 1").get(job.job_id);
        if(!abandoned)return {hasMore:false};
        for(const table of ['agent_cluster_members','agent_clusters','agent_evidence']){
          const removed=this.db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE snapshot_id=? LIMIT 100)`).run(abandoned.snapshot_id).changes;
          if(removed)return {hasMore:true,removed};
        }
        this.db.prepare('DELETE FROM agent_snapshots WHERE snapshot_id=?').run(abandoned.snapshot_id);
        return {hasMore:true,removed:1};
      }
      if(job.snapshot_id)return this.snapshotInfo(job.snapshot_id);
      if(input.phase==="begin"){
        const p=input.prepared;
        if(!p?.manifest?.sealed || !safeId(p.snapshotId) || p.scope!==job.scope || !Object.keys(p.manifest.domains).length)throw agentError("AGENT_INVALID_SNAPSHOT");
        const manifest={...p.manifest,sealed:false,building:{jobId:job.job_id,owner:input.owner,fence:input.fence,page:0,counts:input.counts}};
        this.db.prepare("INSERT INTO agent_snapshots VALUES(?,?,?,?)").run(p.snapshotId,p.asOf,p.scope,json(manifest));
        return {snapshotId:p.snapshotId};
      }
      const row=this.db.prepare("SELECT * FROM agent_snapshots WHERE snapshot_id=?").get(input.snapshotId),manifest=row?parse(row.manifest_json):null,build=manifest?.building;
      if(!build || build.jobId!==job.job_id || build.owner!==input.owner || build.fence!==input.fence || build.page!==input.page)throw agentError("AGENT_SNAPSHOT_BUILD_CONFLICT",409);
      if(input.phase==="page"){
        const statements={evidence:"INSERT INTO agent_evidence(snapshot_id,evidence_id,domain,available_at,article_id,article_revision,payload_json) VALUES(?,?,?,?,?,?,?)",clusters:"INSERT INTO agent_clusters VALUES(?,?,?,?)",members:"INSERT INTO agent_cluster_members VALUES(?,?,?)"};
        if(!statements[input.table] || !Array.isArray(input.rows) || input.rows.length>100)throw agentError("AGENT_INVALID_SNAPSHOT");
        const insert=this.db.prepare(statements[input.table]);for(const values of input.rows)insert.run(input.snapshotId,...values);
        this.fenced(input);
        build.page++;
        this.db.prepare("UPDATE agent_snapshots SET manifest_json=? WHERE snapshot_id=?").run(json(manifest),input.snapshotId);
        return {persisted:true,page:build.page};
      }
      if(input.phase!=="seal")throw agentError("AGENT_INVALID_SNAPSHOT");
      for(const [table,sqlTable]of Object.entries({evidence:"agent_evidence",clusters:"agent_clusters",members:"agent_cluster_members"})){
        if(this.db.prepare(`SELECT count(*) AS n FROM ${sqlTable} WHERE snapshot_id=?`).get(input.snapshotId).n!==build.counts[table])throw agentError("AGENT_SNAPSHOT_BUILD_INCOMPLETE",409);
      }
      this.fenced(input);
      delete manifest.building;manifest.sealed=true;
      this.db.prepare("UPDATE agent_snapshots SET manifest_json=? WHERE snapshot_id=?").run(json(manifest),input.snapshotId);
      this.db.prepare("UPDATE agent_jobs SET snapshot_id=? WHERE job_id=?").run(input.snapshotId,job.job_id);
      return this.snapshotInfo(input.snapshotId);
    }).immediate();
  }
  prepareSnapshot(input, {rowSink=null,maxPreparationMs=15000}={}) {
    const preparationStarted=performance.now();
    return this.db
      .transaction(() => {
        // Pin the reader's consistent view before choosing its temporal cut.
        const job = this.fenced(input);
        if (job.snapshot_id) return {existing:this.snapshotInfo(job.snapshot_id)};
        if(job.task==='situation_analysis')return prepareAnalysis(this,job,{rowSink,maxPreparationMs});
        const chatContext=parse(job.input_json).appContext;
        if(job.task==='contextual_chat'&&chatContext?.situationId){const prepared=prepareAnalysis(this,{...job,scope:chatContext.situationId,input_json:json({...parse(job.input_json),context:chatContext})},{rowSink,maxPreparationMs});return {...prepared,scope:job.scope};}
        const snapshotId = randomUUID(),
          requestContext = parse(job.input_json).appContext || parse(job.input_json).context,
          selection = requestContext && !Array.isArray(requestContext) ? requestContext : null,
          asOf = selection?.capturedAt || stamp(this.now()),
          since = selection?.from || stamp(Date.parse(asOf) - 86400000),
          manifest = {
            complete: false,
            ...(selection?{requestContext:selection,partial:true}:{}),
            reasonCodes: ["collected-sources-only"],
            domains: {},
            windowHours: 24,
            newsFreshnessPolicy:{...NEWS_FRESHNESS_POLICY},
            selectedInstrumentIds:
              parse(job.input_json).selectedInstrumentIds || [],
          };
        const rowsFor=table=>rowSink?{length:0,push(row){rowSink(table,row);this.length++;}}:[];
        const evidence=rowsFor('evidence'),clusters=rowsFor('clusters'),members=rowsFor('members'),seen=new Set(),groups=new Map(),digest=createHash("sha256");
        let selectionBytes=0;
        const add=(id,domain,at,data,articleId=null,articleRevision=null,articlePayload=null)=>{
          if(performance.now()-preparationStarted>maxPreparationMs)throw agentError('AGENT_SNAPSHOT_PREPARATION_TIMEOUT',503);
          if(seen.has(id))return;
          if(data&&['technical.get','indicators.calculate'].includes(domain))data={...data,numericSemantics:{version:NUMERIC_CONTRACT_VERSION,methodVersion:data.methodVersion,seriesRevision:data.seriesRevision||null}};
          const payload=data===null?null:json(data);
          if(selection){const size=Buffer.byteLength(payload||articlePayload||'');if(domain!=='coverage'&&selectionBytes+size>2097152){manifest.reasonCodes.push('evidence-budget-exhausted');return;}selectionBytes+=size;}
          seen.add(id);
          evidence.push([id,domain,at,articleId,articleRevision,payload]);
          digest.update(json([id,domain,at,payload || articlePayload]));
          manifest.domains[domain]={...(manifest.domains[domain] || {}),freeze:manifest.domains[domain]?.freeze || "materialized"};
        };
        const filter =
          job.task === "instrument_outlook"
            ? "AND EXISTS(SELECT 1 FROM article_instruments i WHERE i.article_id=r.article_id AND i.instrument_id=?)"
            : "";
        // Keep the publication expression index usable. COALESCE forced two
        // scans of the entire revision archive while occupying the writer.
        // The NULL branch uses the same index and retains receivedAt fallback.
        const branchParams = [
          since,
          selection?.to || asOf,
          asOf,
          asOf,
          ...(filter ? [job.scope] : []),
        ];
        const params = [...branchParams, ...branchParams];
        const sql = [
          "json_extract(r.payload_json,'$.publishedAt') BETWEEN ? AND ?",
          "json_extract(r.payload_json,'$.publishedAt') IS NULL AND json_extract(r.payload_json,'$.receivedAt') BETWEEN ? AND ?",
        ]
          .map(
            (dateFilter) =>
              `SELECT r.rowid,r.article_id,r.revision,r.observed_at FROM article_revisions r WHERE ${dateFilter} AND r.observed_at<=? AND NOT EXISTS(SELECT 1 FROM article_revisions n INDEXED BY article_revisions_available WHERE n.article_id=r.article_id AND n.revision>r.revision AND n.observed_at<=?) ${filter}`,
          )
          .join(" UNION ALL ");
        const countryFilter=selection?.countries?.length?"WHERE EXISTS(SELECT 1 FROM article_countries c WHERE c.article_id=selected.article_id AND c.country IN (SELECT value FROM json_each(?)))":"";
        const references=this.db.prepare(`SELECT * FROM (${sql}) selected ${countryFilter} ORDER BY observed_at DESC,article_id LIMIT ${selection?101:100001}`).all(...params,...(countryFilter?[json(selection.countries)]:[]));
        if(selection&&references.length>100){references.pop();manifest.reasonCodes.push('bounded-news-selection');}
        const count=references.length;
        if(count>100000)throw agentError("AGENT_SCOPE_TOO_LARGE",413);
        manifest.domains.news={count,freeze:"immutable-revisions"};
        for(const r of physicalPages(this.db,"article_revisions",references)){
          const id=`news:${r.article_id}:${r.revision}`;
          add(id,"news",r.observed_at,null,r.article_id,r.revision,r.payload_json);
          if(!seen.has(id))continue;
          const article=permittedArticle(parse(r.payload_json),asOf),
            key=String(article.title || id).normalize("NFKD").replace(/\p{M}+/gu,"").toLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").trim(),
            clusterId=`cluster:${stableHash(key)}`;
          const group=groups.get(clusterId) || {clusterId,title:article.title,memberIds:[],sources:new Set(),severity:classifyThreat({text:`${article.title || ""} ${article.excerpt || ""}`,topicTags:article.topicTags || []}).score || 0};
          group.memberIds.push(id);
          if(article.sourceId || article.provider)group.sources.add(article.sourceId || article.provider);
          groups.set(clusterId,group);
        }
        for (const row of this.db
          .prepare(
            `SELECT * FROM awareness_events WHERE observed_at<=? AND observed_at>=? ORDER BY observed_at DESC ${selection?"LIMIT 101":""}`,
          )
          .iterate(asOf, since)) {
          const e = parse(row.payload_json);
          if(selection&&evidence.length>=201){manifest.reasonCodes.push('bounded-awareness-selection');break;}
          if (admitted(row.source_id))
            add(
              `event:${row.event_id}:${row.revision}`,
              "awareness",
              row.observed_at,
              publicProjection(e, 0, Number.MAX_SAFE_INTEGER),
            );
        }
        for (const kind of [
          "technical.get",
          "indicators.calculate",
          "conditions.getSnapshot",
          "advanced.getSnapshot",
          "forecasts.evaluate",
        ]) {
          const instrumentScoped = [
            "technical.get",
            "indicators.calculate",
          ].includes(kind);
          const scopes = instrumentScoped
            ? job.task === "instrument_outlook"
              ? [job.scope]
              : manifest.selectedInstrumentIds
            : [null];
          let captured = 0;
          for (const instrumentId of scopes)
            for (const interval of instrumentScoped
              ? ["1day", "1h", "15min"]
              : [null]) {
              const row = instrumentScoped
                ? this.db
                    .prepare(
                      "SELECT * FROM analysis_runs INDEXED BY analysis_runs_instrument_time WHERE kind IN ('technical.get','indicators.calculate') AND kind=? AND generated_at<=? AND json_extract(payload_json,'$.instrumentId')=? AND json_extract(payload_json,'$.interval')=? ORDER BY generated_at DESC LIMIT 1",
                    )
                    .get(kind, asOf, instrumentId, interval)
                : this.db
                    .prepare(
                      "SELECT * FROM analysis_runs WHERE kind=? AND generated_at<=? ORDER BY generated_at DESC LIMIT 1",
                    )
                    .get(kind, asOf);
              if (!row) continue;
              const data = parse(row.payload_json);
              delete data.inputManifest;
              add(
                row.analysis_id,
                kind,
                asOf,
                publicProjection(data, 0, Number.MAX_SAFE_INTEGER),
              );
              captured++;
            }
          manifest.domains[kind] = {
            count: captured,
            freeze: "materialized",
            availabilityBasis: "known-at-snapshot; generatedAt-is-not-receipt",
            ...(captured ? {} : { reason: "not-calculated" }),
          };
        }
        if(selection)manifest.reasonCodes.push('bounded-domain-selection; not-complete-corpus');
        const alertReferences=new Map();let retainedAlertReferences=0;
        const sourceRevision=this.db.prepare('SELECT * FROM article_revisions WHERE article_id=? AND revision=? AND observed_at<=?');
        const alertRows=selection?.alertId
          ? this.db.prepare('SELECT * FROM geopolitical_alert_revisions WHERE alert_id=? AND revision=?').all(selection.alertId,selection.alertRevision)
          : this.db.prepare(`SELECT * FROM geopolitical_alerts WHERE updated_at<=? ORDER BY updated_at DESC LIMIT ${selection?100:500}`).all(asOf);
        if(selection?.alertId&&!alertRows.length)throw agentError('AGENT_CONTEXT_UNAVAILABLE',409);
        for (const row of alertRows) {
          const alert=parse(row.payload_json),references=[];
          for(const id of Array.isArray(alert.evidenceIds)?alert.evidenceIds:[]){
            if(typeof id!=='string')continue;
            if(!alertReferences.has(id)){
              if(seen.has(id))alertReferences.set(id,{evidenceId:id,available:true,role:'snapshot-member'});
              else{
                const match=/^news:([A-Za-z0-9._-]{1,160}):([1-9]\d{0,9})$/.exec(id);
                const revision=match?sourceRevision.get(match[1],Number(match[2]),asOf):null;
                if(revision){
                  add(id,'news-reference',revision.observed_at,null,revision.article_id,revision.revision,revision.payload_json);
                  retainedAlertReferences++;
                }
                alertReferences.set(id,{evidenceId:id,available:Boolean(revision),role:'alert-source-revision',...(revision?{}:{reason:'exact-revision-unavailable-at-cut'})});
              }
            }
            references.push(alertReferences.get(id));
          }
          add(
            `alert:${row.alert_id}:${row.revision}`,
            "geopolitical-alert",
            asOf,
            {...alert,evidenceIds:references.filter(r=>r.available).map(r=>r.evidenceId),sourceEvidenceReferences:references},
          );
        }
        manifest.domains['news-reference']={count:retainedAlertReferences,freeze:'immutable-revisions',meaning:'exact sources of frozen alerts; historical context outside the current news selection'};
        manifest.domains['geopolitical-alert']={...manifest.domains['geopolitical-alert'],sourceReferences:{requested:alertReferences.size,resolved:[...alertReferences.values()].filter(r=>r.available).length,unavailable:[...alertReferences.values()].filter(r=>!r.available).length}};
        const market = this.runtime.load("market");
        if (market && !selection)
          add(
            `market:${stableHash(market)}`,
            "market",
            asOf,
            publicProjection(market, 0, Number.MAX_SAFE_INTEGER),
          );
        if(!selection)add(
          `pipelines:${snapshotId}`,
          "pipeline-health",
          asOf,
          this.db
            .prepare("SELECT stage_id,state_json FROM pipeline_stage_state")
            .all()
            .map((r) => ({
              pipelineId: r.stage_id,
              ...publicProjection(parse(r.state_json)),
            })),
        );
        if(!selection)for (const row of this.db
          .prepare(
            "SELECT entity_id,payload_json FROM research_rows WHERE collection='companyFacts' LIMIT 100",
          )
          .iterate())
          add(
            `fundamentals:${row.entity_id}:${snapshotId}`,
            "fundamentals",
            asOf,
            {
              ...publicProjection(
                parse(row.payload_json),
                0,
                Number.MAX_SAFE_INTEGER,
              ),
              availabilityBasis:
                "captured-at-snapshot; historical-availability-not-assumed",
            },
          );
        const health = this.db
          .prepare("SELECT source_id,payload_json FROM awareness_source_status")
          .all();
        add(
          `coverage:${snapshotId}`,
          "coverage",
          asOf,
          health.map((r) => ({
            sourceId: r.source_id,
            ...publicProjection(parse(r.payload_json)),
          })),
        );
        let rank = 0;
        for (const g of [...groups.values()].sort(
          (a, b) =>
            b.severity - a.severity ||
            b.memberIds.length - a.memberIds.length ||
            a.clusterId.localeCompare(b.clusterId),
        )) {
          const payload = {
            clusterId: g.clusterId,
            title: g.title,
            rank: ++rank,
            members: g.memberIds.length,
            sourceCount: g.sources.size,
            corroboration: "not-established",
            method: "exact-normalized-headline-v1",
          };
          clusters.push([g.clusterId,rank,json(payload)]);
          for(const id of g.memberIds)members.push([g.clusterId,id]);
        }
        manifest.domains.clusters = {
          count: rank,
          memberCount: count,
          method: "exact-normalized-headline-v1",
          freeze: "materialized",
          semanticGrouping: false,
        };
        manifest.reasonCodes=[...new Set(manifest.reasonCodes)];
        manifest.preparationMs=performance.now()-preparationStarted;
        manifest.evidenceCount = evidence.length;
        manifest.sha256 = digest.digest("hex");
        manifest.sealed = true;
        manifest.reviewCoverage =
          "not-a-read-receipt; cite only material actually consulted";
        return {snapshotId,asOf,scope:job.scope,manifest,rows:{evidence,clusters,members}};
      }).deferred();
  }
  snapshotInfo(id) {
    const r = this.db
      .prepare("SELECT * FROM agent_snapshots WHERE snapshot_id=?")
      .get(id);
    if (!r) throw agentError("AGENT_SNAPSHOT_NOT_FOUND", 404);
    if(!parse(r.manifest_json).sealed)throw agentError("AGENT_SNAPSHOT_BUILD_INCOMPLETE",409);
    return {
      schemaVersion: "ogid-evidence-v1",
      snapshotId: r.snapshot_id,
      revision: 1,
      queriedAt: stamp(this.now()),
      asOf: r.as_of,
      scope: r.scope,
      coverage: parse(r.manifest_json),
    };
  }
  item(row) {
    if (!row) return null;
    const raw = row.payload_json
      ? parse(row.payload_json)
      : parse(
          this.db
            .prepare(
              "SELECT payload_json FROM article_revisions WHERE article_id=? AND revision=?",
            )
            .get(row.article_id, row.article_revision).payload_json,
        );
    let data = raw;
    if (row.domain === "news" || row.domain === "news-reference") {
      data = permittedArticle(raw, row.available_at);
      data.title = raw.title;
      const policy = raw.usagePolicy?.contentPolicy || raw.usagePolicy;
      if (
        ![policy, policy?.mode, raw.provenance?.contentPolicy].includes(
          "headline-only-link-out",
        )
      ) {
        const saved = this.db
          .prepare(
            "SELECT excerpt,sha256 FROM article_permitted_excerpts WHERE article_id=? AND revision=?",
          )
          .get(row.article_id, row.article_revision);
        data.excerpt = saved?.excerpt || raw.excerpt || raw.description || null;
        data.excerptCoverage = saved
          ? "retained-permitted-description"
          : "historical-compact-excerpt-only";
        if (saved) data.excerptSha256 = saved.sha256;
      }
    }
    const quality = {
        synthetic: Boolean(
          raw.synthetic ||
          raw.quality?.synthetic ||
          raw.provenance?.synthetic ||
          raw.provider === "fallback",
        ),
        stale: Boolean(
          raw.stale || raw.quality?.stale || raw.provenance?.stale,
        ),
        dataMode: raw.dataMode || null,
      };
    return {
      evidenceId: row.evidence_id,
      domain: row.domain,
      ...(row.domain==='news-reference'?{contextRole:'historical-alert-source'}:{}),
      revision: row.article_revision || raw.revision || null,
      availableAt: row.available_at,
      quality,
      publicationEligibility:{eligible:evidencePublicationCode({quality})===null,reason:evidencePublicationCode({quality})},
      data,
      ...(['technical.get','indicators.calculate'].includes(row.domain) ? {numericCatalog:{...numericPaths(data),
        snapshotId:row.snapshot_id,evidenceId:row.evidence_id,
        continuation:{operationId:'agent.evidence.chunk',parameters:{snapshotId:row.snapshot_id,evidenceId:row.evidence_id,format:'utf8'}}}} : {}),
    };
  }
  evidence({ snapshotId, cursor = 0, limit = 20, domain }) {
    const info = this.snapshotInfo(snapshotId),
      args = [snapshotId, Number(cursor) || 0];
    if (domain) args.push(domain);
    args.push(pageLimit(limit) + 1);
    const rows = this.db
        .prepare(
          `SELECT * FROM agent_evidence WHERE snapshot_id=? AND sequence>? ${domain ? "AND domain=?" : ""} ORDER BY sequence LIMIT ?`,
        )
        .all(...args),
      items = [];
    let bytes = Buffer.byteLength(json(info)) + 256,
      next = Number(cursor) || 0;
    for (const r of rows) {
      if (items.length >= pageLimit(limit)) break;
      let item = this.item(r);
      const encoded = json(item);
      if (Buffer.byteLength(encoded) > INLINE_EVIDENCE_BYTES)
        item = {
          evidenceId: r.evidence_id,
          domain: r.domain,
          representation: "chunked",
          bytes: Buffer.byteLength(encoded),
          sha256: hash(encoded),
        };
      const n = Buffer.byteLength(json(item));
      if (items.length && bytes + n > TOOL_PAGE_BYTES) break;
      items.push(item);
      bytes += n;
      next = r.sequence;
    }
    const hasMore = Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM agent_evidence WHERE snapshot_id=? AND sequence>? " +
            (domain ? "AND domain=?" : ""),
        )
        .get(...[snapshotId, next, ...(domain ? [domain] : [])]),
    );
    const result = {
      ...info,
      items,
      hasMore,
      nextCursor: hasMore ? String(next) : null,
    };
    if (!validateEvidence(result))
      throw agentError("AGENT_EVIDENCE_SCHEMA_INVALID", 500);
    return result;
  }
  clusters({ snapshotId, clusterId, cursor = 0, limit = 20 }) {
    const info = this.snapshotInfo(snapshotId),
      n = Number(cursor) || 0,
      size = pageLimit(limit);
    const page = (rows, key, project) => {
      const selected = [];
      let bytes = Buffer.byteLength(json(info)) + 256;
      for (const row of rows) {
        if (selected.length >= size) break;
        const item = project(row), length = Buffer.byteLength(json(item));
        if (selected.length && bytes + length > TOOL_PAGE_BYTES) break;
        selected.push({row, item});
        bytes += length;
      }
      const hasMore = rows.length > selected.length;
      return {...info, ...(clusterId ? {clusterId} : {}), items:selected.map(x=>x.item), hasMore,
        nextCursor:hasMore ? String(selected.at(-1).row[key]) : null};
    };
    if (clusterId) {
      if (
        !this.db
          .prepare(
            "SELECT 1 FROM agent_clusters WHERE snapshot_id=? AND cluster_id=?",
          )
          .get(snapshotId, clusterId)
      )
        throw agentError("AGENT_CLUSTER_NOT_FOUND", 404);
      const rows = this.db
          .prepare(
            "SELECT e.sequence,e.evidence_id AS evidenceId,e.domain,e.available_at AS availableAt FROM agent_cluster_members m JOIN agent_evidence e USING(snapshot_id,evidence_id) WHERE m.snapshot_id=? AND m.cluster_id=? AND e.sequence>? ORDER BY e.sequence LIMIT ?",
          )
          .all(snapshotId, clusterId, n, size + 1);
      return page(rows, 'sequence', ({sequence, ...r})=>r);
    }
    const rows = this.db
        .prepare(
          "SELECT rank,payload_json FROM agent_clusters WHERE snapshot_id=? AND rank>? ORDER BY rank LIMIT ?",
        )
        .all(snapshotId, n, size + 1);
    return page(rows, 'rank', r=>parse(r.payload_json));
  }
  evidenceChunk({ snapshotId, evidenceId, offset = 0, format = "base64" }) {
    this.snapshotInfo(snapshotId);
    const row = this.db
      .prepare(
        "SELECT * FROM agent_evidence WHERE snapshot_id=? AND evidence_id=?",
      )
      .get(snapshotId, evidenceId);
    if (!row) throw agentError("AGENT_EVIDENCE_NOT_FOUND", 404);
    const b = Buffer.from(json(this.item(row))),
      n = Number(offset);
    if (!Number.isSafeInteger(n) || n < 0 || n > b.length)
      throw agentError("AGENT_INVALID_CURSOR");
    if (!["base64", "utf8"].includes(format))
      throw agentError("AGENT_INVALID_FORMAT");
    let end = Math.min(n + 16384, b.length);
    if (format === "utf8") {
      if (n < b.length && (b[n] & 0xc0) === 0x80)
        throw agentError("AGENT_INVALID_CURSOR");
      while (end < b.length && (b[end] & 0xc0) === 0x80) end--;
      // Escaped characters can expand in JSON; keep the encoded frame small,
      // not just its source buffer, without losing any bytes between offsets.
      while (Buffer.byteLength(json(b.subarray(n,end).toString('utf8'))) > 22000) {
        end = n + Math.floor((end-n)/2);
        while (end < b.length && (b[end] & 0xc0) === 0x80) end--;
      }
    }
    return {
      snapshotId,
      evidenceId,
      encoding: format,
      chunk: b
        .subarray(n, end)
        .toString(format === "base64" ? "base64" : "utf8"),
      sha256: hash(b),
      bytes: b.length,
      nextOffset: end,
      hasMore: end < b.length,
    };
  }
  publish(input) {
    const validationStarted=performance.now();
    input={...input,proposal:normalizePublicationEvidence(input.proposal)};
    const previous = this.db
      .prepare("SELECT * FROM agent_publications WHERE job_id=?")
      .get(input.jobId);
    if (previous) {
      const completedJob = this.job(input.jobId);
      if (completedJob.lease_owner !== input.owner || completedJob.fence !== input.fence)
        throw agentError("AGENT_LEASE_LOST", 409);
      if (
        stableHash(parse(previous.payload_json).proposal) !==
        stableHash(input.proposal)
      )
        throw agentError("AGENT_IDEMPOTENCY_CONFLICT", 409);
      return { publicationId: previous.publication_id, replayed: true };
    }
    const job = this.fenced(input),
      snapshot = this.snapshotInfo(job.snapshot_id);
    if (!["shadow", "visible"].includes(input.mode))
      throw agentError("AGENT_INVALID_MODE");
    if((job.task==='situation_analysis'||parse(job.input_json).origin==='user')&&input.mode!=='shadow')throw agentError('AGENT_INVALID_MODE');
    const proposal = assertPublication(input.proposal, {
      job: { task: job.task, scope: job.scope,promptVersion:job.prompt_version },
      snapshot,
      lookup: (id) =>
        this.item(
          this.db
            .prepare(
              "SELECT * FROM agent_evidence WHERE snapshot_id=? AND evidence_id=?",
            )
            .get(job.snapshot_id, id),
        ),
      now: this.now(),
    });
    this.runtime.lastValidationMs=performance.now()-validationStarted;
    const transactionStarted=performance.now();
    const committed=this.db
      .transaction(() => {
        // Validation can take longer than the lease on a cold database. Check
        // again at the commit boundary; serialized JS does not stop wall time.
        this.fenced(input);
        const at = stamp(this.now()),
          publicationId = randomUUID(),
          validUntil = stamp(this.now() + 86400000);
        const newer = this.db
          .prepare(
            "SELECT 1 FROM agent_publications p JOIN agent_snapshots s USING(snapshot_id) JOIN agent_jobs j ON j.job_id=p.job_id WHERE p.task=? AND p.scope=? AND s.as_of>? AND j.session_id IS ?",
          )
          .get(job.task, job.scope, snapshot.asOf,job.session_id);
        if (newer) {
          this.db
            .prepare(
              "UPDATE agent_jobs SET status='superseded',updated_at=? WHERE job_id=?",
            )
            .run(at, job.job_id);
          this.db
            .prepare(
              "UPDATE agent_runs SET status='superseded',finished_at=? WHERE job_id=? AND fence=?",
            )
            .run(at, job.job_id, job.fence);
          return { status: "superseded" };
        }
        let forecastId = null;
        if (
          job.task === "instrument_outlook" && !job.session_id &&
          ["up", "down", "flat"].includes(proposal.direction)
        ) {
          const technical = this.db
            .prepare(
              "SELECT 1 FROM agent_evidence WHERE snapshot_id=? AND domain='technical.get'",
            )
            .get(job.snapshot_id);
          if (!technical)
            throw agentError("AGENT_TECHNICAL_DATA_REQUIRED", 409);
          forecastId = `agent:${job.job_id}`;
          this.runtime.services.forecasts.record({
            forecastId,
            instrumentId: job.scope,
            target: "direction",
            direction: proposal.direction,
            horizonHours: 24,
            modelVersion: `${job.model}:${job.prompt_version}`,
            evidence: proposal.evidenceIds.map((id) => ({
              sourceId: id,
              availableAt: this.db
                .prepare(
                  "SELECT available_at FROM agent_evidence WHERE snapshot_id=? AND evidence_id=?",
                )
                .get(job.snapshot_id, id).available_at,
            })),
          });
        }
        const payload = {
          schemaVersion: "ogid-agent-publication-v1",
          publicationId,
          jobId: job.job_id,
          runId: `${job.job_id}:${job.fence}`,
          model: job.model,
          promptVersion: job.prompt_version,
          snapshotId: job.snapshot_id,
          coverage: {
            ...snapshot.coverage,
            citedEvidenceCount: proposal.evidenceIds.length,
            uncitedEvidenceCount: Math.max(
              0,
              (snapshot.coverage.evidenceCount || 0) -
                proposal.evidenceIds.length,
            ),
            fullCorpusReviewVerified: false,
          },
          evidenceAsOf: snapshot.asOf,
          publishedAt: at,
          validUntil,
          forecastId,
          ...(job.task==='situation_analysis'?{currentnessAtPublication:analysisCurrentness(this,job.snapshot_id)}:{}),
          proposal,
        };
        this.db
          .prepare("INSERT INTO agent_publications VALUES(?,?,?,?,?,?,?,?,?)")
          .run(
            publicationId,
            job.job_id,
            job.snapshot_id,
            job.task,
            job.scope,
            at,
            validUntil,
            input.mode,
            json(payload),
          );
        if(job.task==='situation_analysis')commitAnalysisDependencies(this,publicationId,job.snapshot_id,proposal);
        if(job.task!=='situation_analysis'&&!job.session_id)this.db.prepare("INSERT INTO agent_memory VALUES(?,?,?,?)").run(
          job.scope,
          publicationId,
          at,
          json({
            summary: proposal.summary,
            evidenceIds: proposal.evidenceIds,
            contradictions: proposal.contradictions,
            invalidation: proposal.invalidation,
            derived: true,
          }),
        );
        for (const assessment of input.mode === "visible"
          ? proposal.alertAssessments || []
          : []) {
          const alert = this.db
            .prepare("SELECT * FROM geopolitical_alerts WHERE alert_id=?")
            .get(assessment.alertId);
          // A newer detection is never overwritten by an older assessment.
          if (!alert || alert.revision !== assessment.revision) continue;
          const revision = alert.revision + 1,
            payload = {
              ...parse(alert.payload_json),
              revision,
              updatedAt: at,
              agentAssessment: {
                publicationId,
                model: job.model,
                publishedAt: at,
                evidenceAsOf: snapshot.asOf,
                summary: assessment.summary,
                evidenceIds: assessment.evidenceIds,
              },
              revisionReason: "agent-assessment",
            };
          this.db
            .prepare(
              "UPDATE geopolitical_alerts SET revision=?,updated_at=?,payload_json=? WHERE alert_id=?",
            )
            .run(revision, at, json(payload), alert.alert_id);
          this.db
            .prepare("INSERT INTO geopolitical_alert_revisions VALUES(?,?,?)")
            .run(alert.alert_id, revision, json(payload));
        }
        this.fenced(input);
        this.db
          .prepare(
            "UPDATE agent_jobs SET status='completed',updated_at=? WHERE job_id=?",
          )
          .run(at, job.job_id);
        this.db
          .prepare(
            "UPDATE agent_runs SET status='completed',finished_at=?,metadata_json=json_patch(metadata_json,?) WHERE job_id=? AND fence=?",
          )
          .run(
            at,
            json(publicProjection(input.metadata || {})),
            job.job_id,
            job.fence,
          );
        if(job.session_id)this.db.prepare('INSERT INTO agent_messages VALUES(?,?,?,?,?,?)').run(randomUUID(),job.session_id,'assistant',at,json({text:proposal.summary,publicationId,jobId:job.job_id,snapshotId:job.snapshot_id,evidenceIds:proposal.evidenceIds,task:job.task,mode:input.mode}),`result:${job.job_id}`);
        this.recordRecovery(job,{...input,status:"completed"});
        return { publicationId, status: "completed" };
      })
      .immediate();
    this.runtime.lastCommitMs=performance.now()-transactionStarted;
    return committed;
  }
  publicationCurrentness(snapshotId,proposal) {
    if(proposal?.task==='situation_analysis')return analysisCurrentness(this,snapshotId);
    const all=(proposal?.evidenceIds||[]).filter(x=>/^(news|event|alert):/.test(x)),items=[];
    for(const evidenceId of all.slice(0,100)){
      const match=/^(news|event|alert):(.*):(\d+)$/.exec(evidenceId);if(!match)continue;
      const [,kind,sourceId,revision]=match;let current;
      if(kind==='news')current=this.db.prepare('SELECT revision FROM articles WHERE article_id=?').get(sourceId)?.revision;
      else if(kind==='event')current=this.db.prepare('SELECT revision FROM awareness_events WHERE event_id=?').get(sourceId)?.revision;
      else{
        const frozen=this.db.prepare("SELECT json_extract(payload_json,'$.sourceRevision') revision FROM agent_evidence WHERE snapshot_id=? AND evidence_id=?").get(snapshotId,evidenceId);
        const live=this.db.prepare("SELECT json_extract(payload_json,'$.sourceRevision') revision FROM geopolitical_alerts WHERE alert_id=?").get(sourceId);
        if(frozen?.revision!=null&&live?.revision!=null&&frozen.revision!==live.revision)items.push({evidenceId,reason:'source-revised',currentSourceRevision:live.revision});
        continue;
      }
      if(current==null||Number(current)!==Number(revision))items.push({evidenceId,reason:current==null?'source-unavailable':'source-revised',currentSourceRevision:current??null});
    }
    return {current:items.length===0&&all.length<=100,partial:all.length>100,checkedReferences:Math.min(all.length,100),items:items.slice(0,10),meaning:'current use of immutable evidence; original snapshot is unchanged'};
  }
  publications({
    task,
    scope,
    cursor = "",
    limit = 20,
    includeShadow = false,
  }) {
    const clauses = [
        "task!='situation_analysis'",
        "mode IN ('visible'" + (includeShadow ? ",'shadow'" : "") + ")",
      ],
      args = [];
    if (task) {
      clauses.push("task=?");
      args.push(task);
    }
    if (scope) {
      clauses.push("scope=?");
      args.push(scope);
    }
    if (cursor) {
      clauses.push("rowid<?");
      args.push(Number(cursor));
    }
    args.push(pageLimit(limit) + 1);
    const rows = this.db
      .prepare(
        `SELECT rowid AS page_sequence,* FROM agent_publications WHERE ${clauses.join(" AND ")} ORDER BY rowid DESC LIMIT ?`,
      )
      .all(...args);
    const hasMore = rows.length > pageLimit(limit);
    if (hasMore) rows.pop();
    const items = rows
      .map((r) => {
        const value=parse(r.payload_json),sourceCurrentness=this.publicationCurrentness(r.snapshot_id,value.proposal);
        return {...value,sourceCurrentness,status:!sourceCurrentness.current?'needs-review':Date.parse(r.valid_until)<=this.now()?'stale':'ready'};
      })
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    return {
      items,
      hasMore,
      nextCursor: hasMore ? String(rows.at(-1).page_sequence) : null,
    };
  }
  memory({ scope = "global" }) {
    return {
      items: this.db
        .prepare(
          "SELECT payload_json FROM agent_memory WHERE scope=? ORDER BY created_at DESC LIMIT 5",
        )
        .all(scope)
        .map((r) => parse(r.payload_json)),
      derived: true,
    };
  }
  get situations(){return this.situationStore ||= new SituationStore(this.db,{now:this.now});}
  alertSync(input={}) {return this.situations.processPage(input);}
  alerts(input={}) {return this.situations.alerts(input,()=>this.legacyAlerts(input));}
  legacyAlerts({
    deviceId = "",
    cursor = "",
    limit = 20,
    state = "open",
    severity = "all",
  }) {
    if (
      !["all", "open", "unread", "archived"].includes(state) ||
      !["all", "high", "critical"].includes(severity)
    )
      throw agentError("AGENT_INVALID_FILTER");
    let page = { at: stamp(this.now()) };
    if (cursor) {
      try {
        page = parse(Buffer.from(cursor, "base64url").toString());
        if (
          !Number.isFinite(Date.parse(page.at)) ||
          !Number.isFinite(Date.parse(page.updatedAt)) ||
          !safeId(page.id)
        )
          throw Error();
      } catch {
        throw agentError("AGENT_INVALID_CURSOR");
      }
    }
    const args = [deviceId, page.at],
      where = ["a.updated_at<=?"];
    if (page.id) {
      where.push("(a.updated_at<? OR (a.updated_at=? AND a.alert_id>?))");
      args.push(page.updatedAt, page.updatedAt, page.id);
    }
    if (state === "open") where.push("coalesce(s.archived,0)=0");
    if (state === "unread")
      where.push(
        "coalesce(s.archived,0)=0 AND coalesce(s.read_revision,0)<a.revision",
      );
    if (state === "archived") where.push("s.archived=1");
    if (severity === "critical")
      where.push("json_extract(a.payload_json,'$.severity')='critical'");
    if (severity === "high")
      where.push(
        "json_extract(a.payload_json,'$.severity') IN ('critical','high','elevated')",
      );
    args.push(pageLimit(limit) + 1);
    const rows = this.db
        .prepare(
          `SELECT a.*,s.read_revision,s.archived FROM geopolitical_alerts a LEFT JOIN geopolitical_alert_state s ON s.alert_id=a.alert_id AND s.device_id=? WHERE ${where.join(" AND ")} ORDER BY a.updated_at DESC,a.alert_id ASC LIMIT ?`,
        )
        .all(...args),
      hasMore = rows.length > pageLimit(limit);
    if (hasMore) rows.pop();
    return {
      items: rows.map((r) => ({
        ...parse(r.payload_json),
        read: r.read_revision >= r.revision,
        archived: Boolean(r.archived),
      })),
      hasMore,
      nextCursor: hasMore
        ? Buffer.from(
            json({
              at: page.at,
              updatedAt: rows.at(-1).updated_at,
              id: rows.at(-1).alert_id,
            }),
          ).toString("base64url")
        : null,
      coverage: {
        partial: true,
        reason:
          "admitted-official-sources-and-collected-news; syndication-not-corroboration",
      },
    };
  }
  alertRevisions({ alertId, cursor = 0, limit = 20 }) {
    const rows = this.db
        .prepare(
          "SELECT revision,payload_json FROM geopolitical_alert_revisions WHERE alert_id=? AND revision>? ORDER BY revision LIMIT ?",
        )
        .all(alertId, Number(cursor) || 0, pageLimit(limit) + 1),
      hasMore = rows.length > pageLimit(limit);
    if (hasMore) rows.pop();
    return {
      items: rows.map((r) => parse(r.payload_json)),
      hasMore,
      nextCursor: hasMore ? String(rows.at(-1).revision) : null,
    };
  }
  alertState({deviceId,alertId,read,archived,revision,requestId}) {
    if(typeof read!=='boolean'||typeof archived!=='boolean')throw agentError('AGENT_INVALID_ALERT_STATE');
    return this.situations.receipt(requestId?`alert-state:${stableHash([deviceId,requestId])}`:null,['alert-state',deviceId,alertId,read,archived,revision??null],()=>{
      const current=this.db.prepare('SELECT revision FROM geopolitical_alerts WHERE alert_id=?').get(alertId);
      if(!current)throw agentError('AGENT_ALERT_NOT_FOUND',404);
      const acknowledged=revision??current.revision;
      if(!Number.isInteger(acknowledged)||acknowledged<1||acknowledged>current.revision)throw agentError('AGENT_INVALID_ALERT_STATE');
      this.db.prepare('INSERT INTO geopolitical_alert_state VALUES(?,?,?,?) ON CONFLICT(device_id,alert_id) DO UPDATE SET read_revision=CASE WHEN excluded.read_revision=0 THEN 0 ELSE max(read_revision,excluded.read_revision) END,archived=excluded.archived').run(deviceId,alertId,read?acknowledged:0,Number(archived));
      return {updated:true,acknowledgedRevision:acknowledged};
    });
  }
  runControl({jobId}) {
    const row=this.db.prepare('SELECT job_id jobId,status,fence,task FROM agent_jobs WHERE job_id=?').get(jobId);
    if(!row)throw agentError('AGENT_RUN_NOT_FOUND',404);
    return row;
  }
  run({ jobId, deviceId, internal = false }) {
    const r = this.job(jobId);
    if (!internal) {
      if (!r.session_id) throw agentError("AGENT_RUN_NOT_FOUND", 404);
      this.owned(r.session_id, deviceId);
    }
    const result=this.wire(r);
    if(!internal){const publication=this.db.prepare('SELECT payload_json FROM agent_publications WHERE job_id=?').get(jobId);if(publication){result.publication=parse(publication.payload_json);result.publication.currentness=this.publicationCurrentness(r.snapshot_id,result.publication.proposal);}}
    return result;
  }
  cancel(input) {
    return this.db
      .transaction(() => {
        const r = this.job(input.jobId);
        if (!input.internal) {
          if (!r.session_id) throw agentError("AGENT_RUN_NOT_FOUND", 404);
          this.owned(r.session_id, input.deviceId);
        }
        if (active.includes(r.status)) {
          const at = stamp(this.now());
          this.db
            .prepare(
              "UPDATE agent_jobs SET status='cancelled',updated_at=?,lease_until=0 WHERE job_id=?",
            )
            .run(at, r.job_id);
          this.db
            .prepare(
              "UPDATE agent_runs SET status='cancelled',finished_at=? WHERE job_id=? AND fence=?",
            )
            .run(at, r.job_id, r.fence);
        }
        return { status: this.job(r.job_id).status, opencodeId: r.opencode_id };
      })
      .immediate();
  }
}
