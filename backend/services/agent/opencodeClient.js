import {readEvents} from './eventStream.js';
import {toolReceipt} from './toolReceipt.js';
import {terminalFailure,transportFailure} from './failures.js';
import {agentToolCall} from '../../contracts/ogidOperations.js';
import { agentError } from "./contracts.js";
import { localUrl } from "./config.js";
import { createHash } from "node:crypto";
const stableInput = (value) =>
  Array.isArray(value)
    ? value.map(stableInput)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, stableInput(value[k])]),
        )
      : value;
export class OpenCodeClient {
  constructor({
    baseUrl = "http://127.0.0.1:4096",
    password,
    fetchImpl = fetch,
  } = {}) {
    this.baseUrl = localUrl(baseUrl).origin;
    this.password = password;
    this.fetch = fetchImpl;
    this.progressCache=new Map();this.eventHints=new Set();
  }
  startEvents(signal) {
    if(this.eventsTask)return this.eventsTask;
    this.eventsTask=(async()=>{
      while(!signal.aborted){
        try{
          const response=await this.fetch(this.baseUrl+'/api/event',{signal,redirect:'error',headers:{Authorization:'Basic '+Buffer.from(`opencode:${this.password}`).toString('base64'),Accept:'text/event-stream'}});
          if(!response.ok){await response.body?.cancel();throw Error('OPENCODE_EVENTS_UNAVAILABLE');}
          this.eventsConnected=true;
          await readEvents(response.body,event=>{
            const encoded=JSON.stringify(event);
            // Only terminal hints bypass the periodic reconciliation budget.
            if(['session.idle','session.error'].includes(event?.type))for(const key of this.progressCache.keys())if(encoded.includes(key.split('|')[0]))this.eventHints.add(key);
          },signal);
        }catch{this.eventsConnected=false;}
        finally{this.eventsConnected=false;}
        if(!signal.aborted)await new Promise(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,15000);signal.addEventListener('abort',done,{once:true});});
      }
    })().finally(()=>{this.eventsTask=null;});
    return this.eventsTask;
  }
  async request(path, { method = "GET", body, signal } = {}) {
    signal = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(30000),
    ]);
    let r;
    try { r = await this.fetch(this.baseUrl + path, {
      method,
      signal,
      redirect: "error",
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(`opencode:${this.password}`).toString("base64"),
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }); } catch(error) {
      const failure=transportFailure(error);
      throw agentError(failure.causeCode,502,{terminalError:failure});
    }
    if (!r.ok) {
      await r.body?.cancel();
      throw agentError(`OPENCODE_HTTP_${r.status}`, 502,{terminalError:{causeCode:`OPENCODE_HTTP_${r.status}`,phase:'opencode-http',httpStatus:r.status,observedAt:new Date().toISOString()}});
    }
    if (r.status === 204) return null;
    const reader = r.body.getReader(),
      parts = [];
    let bytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 2097152) throw agentError("OPENCODE_RESPONSE_TOO_LARGE", 502);
        parts.push(value);
      }
      try { return JSON.parse(Buffer.concat(parts).toString()); }
      catch { throw agentError('OPENCODE_INVALID_RESPONSE', 502); }
    } catch(error) {
      if(error.code?.startsWith?.('OPENCODE_'))throw error;
      const failure=transportFailure(error);
      throw agentError(failure.causeCode,502,{terminalError:failure});
    } finally {
      await reader.cancel().catch(()=>{});reader.releaseLock();
    }
  }
  async verify(signal) {
    const info = await this.request("/api/info", { signal });
    if (info.version !== "2.0.31")
      throw agentError("OPENCODE_VERSION_UNVERIFIED", 503);
    const mcp = await this.request("/api/mcp", { signal });
    if (
      !mcp.data?.some(
        (s) => s.name === "ogid_read" && s.status?.status === "connected",
      )
    )
      throw agentError("OPENCODE_MCP_NOT_READY", 503);
    return { version: info.version, ready: true, checkedAt:new Date().toISOString(), mcp:{state:'connected',name:'ogid_read',profile:'agent-evidence'} };
  }
  models(signal) {
    return this.request("/api/model", { signal });
  }
  async create({ id, model, title, signal, chat = false, alert = false }) {
    const d = await this.request("/api/session", {
      method: "POST",
      signal,
      body: {
        id,
        agent: chat
          ? "ogid-analyst-chat"
          : alert
            ? "ogid-analyst-alert"
            : "ogid-analyst",
        title,
        model: { providerID: "llamacpp", id: model.replace(/^llamacpp\//, "") },
      },
    });
    return d.data;
  }
  prompt(id, { messageId, text, signal }) {
    return this.request(`/api/session/${encodeURIComponent(id)}/prompt`, {
      method: "POST",
      signal,
      body: {
        id: messageId,
        text,
        files: [],
        agents: [],
        skills: [],
        metadata: { origin: "ogid" },
      },
    });
  }
  session(id, signal) {
    return this.request(`/api/session/${encodeURIComponent(id)}`, {
      signal,
    }).then((v) => v.data || v);
  }
  async messages(id, signal, untilId) {
    this.messagePageReads=(this.messagePageReads||0)+1;
    const data = [],
      seen = new Set();
    let cursor;
    do {
      const query = new URLSearchParams({
        limit: "40",
        ...(cursor ? { cursor } : { order: "desc" }),
      });
      const page = await this.request(
        `/api/session/${encodeURIComponent(id)}/message?${query}`,
        { signal },
      );
      data.push(...(page.data || []));
      if (!untilId || data.some((m) => m.id === untilId))
        return { ...page, data };
      const next = page.cursor?.next;
      if (!next) return { ...page, data };
      if (seen.has(next)) throw agentError("OPENCODE_CURSOR_REPEATED", 502);
      seen.add(next);
      cursor = next;
    } while (true);
  }
  async cancel(id) {
    try{return await this.request(`/api/session/${encodeURIComponent(id)}/interrupt`, {
      method: "POST",
      signal: AbortSignal.timeout(10000),
    });}catch(error){
      if(error.code!=='OPENCODE_HTTP_404')throw error;
      try{await this.session(id,AbortSignal.timeout(10000));}catch(check){
        if(check.code==='OPENCODE_HTTP_404')return {state:'absent',observedAt:new Date().toISOString(),originalOutcome:'unknown'};
        throw check;
      }
      throw error;
    }
  }
  async progress(id, signal, messageId, {cache=false}={}) {
    const cacheKey=`${id}|${messageId}`,cached=this.progressCache.get(cacheKey);
    if(cache&&cached&&!cached.value.idle&&Date.now()-cached.at<15000&&!this.eventHints.has(cacheKey))return cached.value;
    this.eventHints.delete(cacheKey);
    const [session, messages] = await Promise.all([
      this.session(id, signal),
      this.messages(id, signal, messageId),
    ]);
    const timeline = messages.data || [];
    const boundary = messageId
      ? timeline.findIndex((m) => m.id === messageId)
      : -1;
    const current =
      boundary >= 0 ? timeline.slice(0, boundary) : messageId ? [] : timeline;
    const assistants = current.filter((m) => m.type === "assistant");
    const latest = assistants[0];
    // v2 may finish an errored turn without assigning session.time.idle.
    // Its completed assistant error is authoritative; waiting for idle would
    // occupy a worker slot until the run deadline after recovery.
    const retryFailure=latest?.retry?.error?terminalFailure(latest.retry.error):null;
    // V2 retries provider.internal inside a still-open assistant turn. A known
    // format rejection or an incomplete stream cannot become valid by waiting
    // on that same attempt: report it now so the owner interrupts and ACKs it.
    const rejectedRetry=Boolean(retryFailure&&['LLAMACPP_OUTPUT_FORMAT','BROKER_INCOMPLETE_STREAM'].includes(retryFailure.causeCode));
    const terminalError=Boolean(rejectedRetry || latest?.time?.completed && latest.finish === "error");
    const userTime=boundary>=0?timeline[boundary]?.time?.created:null;
    const inactive=Number.isFinite(userTime)&&[session.time?.idle,session.time?.archived].some(at=>Number.isFinite(at)&&at>=userTime);
    const result = {
      inactive,
      idle: Boolean(
        terminalError || (latest?.time?.completed && session.time?.idle >= latest.time.completed),
      ),
      boundaryFound:boundary>=0,
      outcome: terminalError ? "failed" : session.outcome,
      text:
        latest?.content
          ?.filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("") || "",
      finish: rejectedRetry?'error':latest?.finish,
      terminalError: terminalError ? rejectedRetry?retryFailure:terminalFailure(latest.error) : null,
      requiresInterruption:rejectedRetry,
      tools: assistants.flatMap((m) =>
        (m.content || [])
          .filter((p) => p.type === "tool")
          .map((p, index) => ({
            ...(toolReceipt(p.state?.error?.message||p.state?.output||p.state?.content)||{applicationOk:false}),
            callId: p.id || `${m.id}:${index}`,
            repeatKey: createHash("sha256")
              .update(
                JSON.stringify([p.name, stableInput(p.state?.input || {})]),
              )
              .digest("hex"),
            name: p.name,
            status: p.state?.status || "running",
            ...agentToolCall(p.name,p.state?.input),
            durationMs:Number.isFinite(p.time?.ran) && Number.isFinite(p.time?.completed) && p.time.completed>=p.time.ran ? p.time.completed-p.time.ran : null,
          })),
      ),
      messageId: latest?.id,
      usage: assistants.map((m) => ({
        messageId: m.id,
        model: m.model,
        tokens: m.tokens,
        time: m.time,
      })),
    };
    if(this.progressCache.size>=128)this.progressCache.delete(this.progressCache.keys().next().value);
    this.progressCache.set(cacheKey,{at:Date.now(),value:result});
    return result;
  }
}
