import {LlamaModels,catalogModel} from "./modelCatalog.js";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { readyModel, localUrl } from "./config.js";
import { agentError } from "./contracts.js";
// Transport budgets, not token/output limits. Queue wait does not consume the
// inference budget; priority applies only before admission (no preemption).
export const BROKER_POLICY = Object.freeze({
  queueMs: 1800000, headersMs: 90000, idleMs: 90000, totalMs: 1800000,
  backpressureMs: 10000, maxChunkBytes: 33554432, maxJsonBytes: 33554432,
});
function validateInput(body, path) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.model !== 'string')
    throw agentError('BROKER_INVALID_INPUT', 400);
  if(path==='/v1/models/activate')return;
  if (path === '/v1/chat/completions' || path === '/apply-template') {
    if (!Array.isArray(body.messages) || !body.messages.length || body.messages.some(m =>
      !m || typeof m !== 'object' || !['system','developer','user','assistant','tool','function'].includes(m.role)) ||
      (body.stream !== undefined && typeof body.stream !== 'boolean') ||
      (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some(t =>
        !t || t.type !== 'function' || typeof t.function?.name !== 'string'))))
      throw agentError('BROKER_INVALID_INPUT', 400);
  } else if (typeof body.content !== 'string') throw agentError('BROKER_INVALID_INPUT', 400);
}
export function tokenMatches(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}
export class InferenceQueue {
  constructor() {
    this.pending = [];
    this.running = false;
    this.counter = 0;
  }
  async run(fn, { signal, model = "", priority = 50 } = {}) {
    signal?.throwIfAborted();
    if (this.pending.length >= 128)
      throw agentError("BROKER_BACKPRESSURE", 503);
    return new Promise((resolve, reject) => {
      const entry = {
        fn,
        resolve,
        reject,
        signal,
        model,
        priority,
        at: Date.now(),
        seq: this.counter++,
      };
      entry.abort = () => {
        const i = this.pending.indexOf(entry);
        if (i >= 0) {
          this.pending.splice(i, 1);
          signal?.removeEventListener('abort', entry.abort);
          reject(signal.reason);
        }
      };
      signal?.addEventListener("abort", entry.abort, { once: true });
      this.pending.push(entry);
      this.pump();
    });
  }
  async pump() {
    if (this.running) return;
    const now = Date.now();
    this.pending.sort(
      (a, b) =>
        a.priority -
          (now - a.at) / 60000 -
          (a.model === this.resident ? 1 : 0) -
          (b.priority -
            (now - b.at) / 60000 -
            (b.model === this.resident ? 1 : 0)) || a.seq - b.seq,
    );
    const e = this.pending.shift();
    if (!e) return;
    this.running = true;
    e.signal?.removeEventListener("abort", e.abort);
    try {
      e.signal?.throwIfAborted();
      this.resident = e.model;
      e.resolve(await e.fn());
    } catch (err) {
      e.reject(err);
    } finally {
      this.running = false;
      this.pump();
    }
  }
}
export async function inspectServerContext({
  base,
  headers,
  body,
  fetchImpl,
  signal,
  model,
}) {
  const propsResponse = await fetchImpl(
    `${base}/props?model=${encodeURIComponent(body.model)}&autoload=true`,
    { headers, signal },
  );
  if (!propsResponse.ok) throw agentError("BROKER_CONTEXT_UNVERIFIED", 503);
  const props = await propsResponse.json(),
    context = props.default_generation_settings?.n_ctx;
  if (
    context !== model.context ||
    (props.total_slots !== model.slots && model.slots !== undefined)
  )
    throw agentError("BROKER_CONTEXT_CHANGED", 409);
  const defaults = props.default_generation_settings?.params;
  if (defaults?.n_predict !== -1 || defaults?.max_tokens !== -1)
    throw agentError("BROKER_OUTPUT_POLICY_CHANGED", 409);
  const template = await fetchImpl(`${base}/apply-template`, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      model: body.model,
      messages: body.messages,
      tools: body.tools || [],
      ...(body.chat_template_kwargs
        ? { chat_template_kwargs: body.chat_template_kwargs }
        : {}),
      ...(body.reasoning_effort
        ? { reasoning_effort: body.reasoning_effort }
        : {}),
      ...(body.tool_choice ? { tool_choice: body.tool_choice } : {}),
      ...(body.parallel_tool_calls !== undefined
        ? { parallel_tool_calls: body.parallel_tool_calls }
        : {}),
      add_generation_prompt: true,
    }),
  });
  if (!template.ok) throw agentError("BROKER_TEMPLATE_UNVERIFIED", 503);
  const rendered = await template.json();
  if (typeof rendered.prompt !== "string")
    throw agentError("BROKER_TEMPLATE_UNVERIFIED", 503);
  if (
    (body.tools || []).some(
      (t) =>
        typeof t.function?.name !== "string" ||
        !rendered.prompt.includes(t.function.name),
    )
  )
    throw agentError("BROKER_TOOL_TEMPLATE_UNVERIFIED", 503);
  const tokenized = await fetchImpl(`${base}/tokenize`, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      model: body.model,
      content: rendered.prompt,
      add_special: false,
      parse_special: true,
    }),
  });
  if (!tokenized.ok) throw agentError("BROKER_TOKENIZER_UNVERIFIED", 503);
  const counted = await tokenized.json();
  if (!Array.isArray(counted.tokens))
    throw agentError("BROKER_TOKENIZER_UNVERIFIED", 503);
  if (counted.tokens.length >= context)
    throw agentError("BROKER_CONTEXT_OVERFLOW", 413);
  return {
    tokens: counted.tokens.length,
    context,
    countMethod: "server-template-and-tokenizer",
  };
}
export function createInferenceBroker({
  upstream = "http://127.0.0.1:8080",
  apiKey,
  token,
  manifest,
  fetchImpl = fetch,
  queue = new InferenceQueue(),
  contextInspector = inspectServerContext,
  policy = {},
  managedModels = false,
} = {}) {
  const limits = { ...BROKER_POLICY, ...policy };
  if (Object.values(limits).some(n => !Number.isSafeInteger(n) || n <= 0))
    throw agentError('BROKER_INVALID_POLICY');
  const base = localUrl(upstream).origin;
  if (!token || !apiKey) throw agentError("BROKER_CREDENTIALS_REQUIRED");
  const gateway=managedModels?new LlamaModels({upstream,apiKey,manifest,fetchImpl}):null;
  return createServer(async (req, res) => {
    const abort = new AbortController();
    let phaseTimer, totalTimer;
    const phase = (ms, code) => {
      clearTimeout(phaseTimer);
      phaseTimer = setTimeout(() => abort.abort(agentError(code, 504)), ms);
      phaseTimer.unref();
    };
    const onClose = () => {
      if (!res.writableEnded) abort.abort();
    };
    const onAborted = () => abort.abort();
    res.on('close', onClose);
    req.on('aborted', onAborted);
    try {
      if (
        !tokenMatches(
          token,
          String(req.headers.authorization || "").replace(/^Bearer /i, ""),
        )
      )
        throw agentError("BROKER_UNAUTHORIZED", 401);
      if (req.method === "GET" && req.url === "/health") {
        res.setHeader("Content-Type", "application/json");
        return res.end(
          JSON.stringify({
            ready: true,
            queue: queue.pending.length,
            running: queue.running,
            resident: queue.resident || null,
          }),
        );
      }
      if (req.method === "GET" && req.url === "/v1/models") {
        if(gateway)await gateway.discover(abort.signal);
        res.setHeader("Content-Type", "application/json");
        return res.end(
          JSON.stringify({
            data: manifest.models
              .filter(catalogModel)
              .map((m) => ({id:m.alias,object:"model",context:m.context,slots:m.slots,verified:readyModel(m),resident:m.resident===true,loadState:m.loadState||"unknown",probe:m.probe,lastProbe:m.lastProbe})),
          }),
        );
      }
      if (
        req.method !== "POST" ||
        !["/v1/chat/completions", "/tokenize", "/apply-template", "/v1/models/activate"].includes(
          req.url,
        )
      )
        throw agentError("BROKER_ROUTE_DENIED", 404);
      const chunks = [];
      let n = 0;
      for await (const b of req) {
        n += b.length;
        if (n > 8388608) throw agentError("BROKER_BODY_TOO_LARGE", 413);
        chunks.push(b);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks)); }
      catch { throw agentError('BROKER_INVALID_JSON', 400); }
      validateInput(body, req.url);
      const model = manifest.models.find((m) => m.alias === body.model);
      if (!catalogModel(model)) throw agentError("BROKER_MODEL_UNVERIFIED", 409);
      if(req.url==='/v1/models/activate'){
        if(!gateway)throw agentError('AGENT_MODEL_ACTIVATION_UNAVAILABLE',503);
        phase(limits.queueMs,'BROKER_QUEUE_TIMEOUT');
        const verified=await queue.run(async()=>{phase(540000,'AGENT_MODEL_ACTIVATION_TIMEOUT');return gateway.validate(body.model,abort.signal);},{signal:abort.signal,model:body.model,priority:10});
        res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({model:verified}));
      }
      if (req.url === "/v1/chat/completions") {
        delete body.max_tokens;
        delete body.max_completion_tokens;
        delete body.n_predict;
        delete body.max_output_tokens;
      }
      const work = async () => {
        clearTimeout(phaseTimer);
        totalTimer = setTimeout(() => abort.abort(agentError('BROKER_TOTAL_TIMEOUT', 504)), limits.totalMs);
        totalTimer.unref();
        if(gateway){phase(540000,'AGENT_MODEL_ACTIVATION_TIMEOUT');if(readyModel(model))await gateway.load(body.model,abort.signal);else await gateway.validate(body.model,abort.signal);}
        phase(limits.headersMs, 'BROKER_HEADERS_TIMEOUT');
        const upstreamHeaders = {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        };
        if (req.url === "/v1/chat/completions")
          queue.context = await contextInspector({
            base,
            headers: upstreamHeaders,
            body,
            model,
            fetchImpl,
            signal: abort.signal,
          });
        const r = await fetchImpl(base + req.url, {
          method: "POST",
          redirect: "error",
          signal: abort.signal,
          headers: upstreamHeaders,
          body: JSON.stringify(body),
        });
        const contentType = r.headers.get('content-type') || '';
        const streaming = body.stream === true && r.ok;
        if (!r.body || !(streaming ? contentType.includes('text/event-stream') : contentType.includes('application/json'))) {
          await r.body?.cancel();
          throw agentError('BROKER_INVALID_UPSTREAM', 502);
        }
        const responseHeaders = {
          "Content-Type": contentType,
          "Cache-Control": "no-store",
        };
        if (streaming) res.writeHead(r.status, responseHeaders);
        const parts = []; let jsonBytes = 0;
        phase(limits.idleMs, 'BROKER_IDLE_TIMEOUT');
        for await (const b of r.body) {
          if (b.length > limits.maxChunkBytes)
            throw agentError('BROKER_CHUNK_TOO_LARGE', 502);
          phase(limits.idleMs, 'BROKER_IDLE_TIMEOUT');
          if (!streaming) {
            jsonBytes += b.length;
            if (jsonBytes > limits.maxJsonBytes) throw agentError('BROKER_JSON_TOO_LARGE', 502);
            parts.push(b); continue;
          }
          if (!res.write(b)) {
            phase(limits.backpressureMs, 'BROKER_BACKPRESSURE_TIMEOUT');
            await once(res, "drain", {
              signal: abort.signal,
            });
            phase(limits.idleMs, 'BROKER_IDLE_TIMEOUT');
          }
        }
        if (!streaming) {
          const bytes = Buffer.concat(parts);
          try { const value = JSON.parse(bytes); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); }
          catch { throw agentError('BROKER_INVALID_UPSTREAM', 502); }
          res.writeHead(r.status, responseHeaders); res.end(bytes);
        } else res.end();
      };
      phase(limits.queueMs, 'BROKER_QUEUE_TIMEOUT');
      await queue.run(work, {
        signal: abort.signal,
        model: body.model,
        priority:
          req.headers["x-ogid-work-class"] === "critical"
            ? 5
            : req.headers["x-ogid-work-class"] === "chat"
              ? 10
              : 50,
      });
    } catch (error) {
      const e = abort.signal.reason?.code?.startsWith?.('BROKER_') ? abort.signal.reason : error;
      // Also cancel upstream on validation/backpressure failures, not just when
      // the client disconnects. Never leave an unread response owning a slot.
      abort.abort(e);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.statusCode = e.statusCode || 502;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({ error: { code: e.code || "BROKER_UPSTREAM_ERROR" } }),
      );
    } finally {
      clearTimeout(phaseTimer); clearTimeout(totalTimer);
      res.removeListener('close', onClose); req.removeListener('aborted', onAborted);
    }
  });
}
