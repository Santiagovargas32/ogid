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
  }
  async request(path, { method = "GET", body, signal } = {}) {
    signal = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(30000),
    ]);
    const r = await this.fetch(this.baseUrl + path, {
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
    });
    if (!r.ok) throw agentError(`OPENCODE_HTTP_${r.status}`, 502);
    if (r.status === 204) return null;
    const reader = r.body.getReader(),
      parts = [];
    let bytes = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2097152) {
        await reader.cancel();
        throw agentError("OPENCODE_RESPONSE_TOO_LARGE", 502);
      }
      parts.push(value);
    }
    return JSON.parse(Buffer.concat(parts).toString());
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
    return { version: info.version, ready: true };
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
  cancel(id) {
    return this.request(`/api/session/${encodeURIComponent(id)}/interrupt`, {
      method: "POST",
      signal: AbortSignal.timeout(10000),
    });
  }
  async progress(id, signal, messageId) {
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
    const terminalError=Boolean(latest?.time?.completed && latest.finish === "error");
    return {
      idle: Boolean(
        terminalError || (latest?.time?.completed && session.time?.idle >= latest.time.completed),
      ),
      outcome: terminalError ? "failed" : session.outcome,
      text:
        latest?.content
          ?.filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("") || "",
      finish: latest?.finish,
      tools: assistants.flatMap((m) =>
        (m.content || [])
          .filter((p) => p.type === "tool")
          .map((p, index) => ({
            callId: p.id || `${m.id}:${index}`,
            repeatKey: createHash("sha256")
              .update(
                JSON.stringify([p.name, stableInput(p.state?.input || {})]),
              )
              .digest("hex"),
            name: p.name,
            status: p.state?.status || "running",
            operationId: p.state?.input?.operationId,
            snapshotId: p.state?.input?.parameters?.snapshotId,
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
  }
}
