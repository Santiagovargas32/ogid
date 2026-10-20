import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { readyModel, localUrl } from "./config.js";
import { agentError } from "./contracts.js";
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
} = {}) {
  const base = localUrl(upstream).origin;
  if (!token || !apiKey) throw agentError("BROKER_CREDENTIALS_REQUIRED");
  return createServer(async (req, res) => {
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });
    req.on("aborted", () => abort.abort());
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
        res.setHeader("Content-Type", "application/json");
        return res.end(
          JSON.stringify({
            data: manifest.models
              .filter(readyModel)
              .map((m) => ({ id: m.alias, object: "model" })),
          }),
        );
      }
      if (
        req.method !== "POST" ||
        !["/v1/chat/completions", "/tokenize", "/apply-template"].includes(
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
      const body = JSON.parse(Buffer.concat(chunks)),
        model = manifest.models.find((m) => m.alias === body.model);
      if (!readyModel(model)) throw agentError("BROKER_MODEL_UNVERIFIED", 409);
      if (req.url === "/v1/chat/completions") {
        delete body.max_tokens;
        delete body.max_completion_tokens;
        delete body.n_predict;
        delete body.max_output_tokens;
      }
      const work = async () => {
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
        res.writeHead(r.status, {
          "Content-Type": r.headers.get("content-type") || "application/json",
          "Cache-Control": "no-store",
        });
        let pending = 0;
        for await (const b of r.body) {
          pending += b.length;
          if (pending > 33554432)
            throw agentError("BROKER_STREAM_TOO_LARGE", 502);
          if (!res.write(b)) {
            const deadline = AbortSignal.timeout(10000);
            await once(res, "drain", {
              signal: AbortSignal.any([abort.signal, deadline]),
            });
          }
          pending = 0;
        }
        res.end();
      };
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
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.statusCode = e.statusCode || 502;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({ error: { code: e.code || "BROKER_UPSTREAM_ERROR" } }),
      );
    }
  });
}
