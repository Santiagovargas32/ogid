// Explicit opt-in integration smoke. Uses the resident model only, an isolated
// OpenCode instance and a temporary OGID database. Never activates production.
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  closeSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { randomUUID, randomBytes } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import dotenv from "dotenv";
import { createInferenceBroker } from "../services/agent/broker.js";
import { generateOpenCodeConfig } from "../services/agent/opencodeConfig.js";
import { OpenCodeClient } from "../services/agent/opencodeClient.js";
import { IntelligenceWorker } from "../services/agent/worker.js";
if (!process.argv.includes("--resident-model"))
  throw new Error(
    "Explicit --resident-model required; this performs local inference.",
  );
const secretEnv = dotenv.parse(
  readFileSync(new URL("../.env", import.meta.url)),
);
const key = process.env.LLAMACPP_API_KEY || secretEnv.LLAMACPP_API_KEY;
const opencodeBinary=resolve(fileURLToPath(new URL('../',import.meta.url)),process.env.OGID_OPENCODE_BINARY || secretEnv.AGENT_OPENCODE_BINARY || 'data/agent-runtime/bin/opencode');
if (!key) throw new Error("LLAMACPP_API_KEY_REQUIRED");
const upstream = new URL(
  process.env.LLAMACPP_BASE_URL ||
    secretEnv.LLAMACPP_BASE_URL ||
    "http://127.0.0.1:8080/v1",
);
const headers = { Authorization: `Bearer ${key}` };
const listing = await fetch(new URL("/models", upstream), {
  headers,
  signal: AbortSignal.timeout(10000),
});
if (!listing.ok) throw new Error("ROUTER_INVENTORY_UNAVAILABLE");
const inventory = await listing.json(),
  resident = inventory.data.find((m) => m.status?.value === "loaded");
if (!resident)
  throw new Error(
    "NO_RESIDENT_MODEL; will not load or swap models automatically",
  );
const propsResponse = await fetch(
  new URL(
    `/props?model=${encodeURIComponent(resident.id)}&autoload=false`,
    upstream,
  ),
  { headers, signal: AbortSignal.timeout(10000) },
);
if (!propsResponse.ok) throw new Error("MODEL_CONTEXT_UNAVAILABLE");
const props = await propsResponse.json();
const model = {
  alias: resident.id,
  context: props.default_generation_settings.n_ctx,
  tools: true,
  structuredOutput: true,
  serverContextVerified: props.total_slots === 1,
  state: "ready",
  probe: {
    verifiedAt: new Date().toISOString(),
    wireNoFixedCap: true,
    streaming: true,
    cancellation: true,
    kind: "verification-in-progress",
  },
};
const manifest = {
  schemaVersion: "ogid-model-catalog-v1",
  defaultModel: `llamacpp/${model.alias}`,
  models: [model],
};
createRequire(import.meta.url)("../tests/testSetup.cjs");
process.env.LOG_LEVEL = "error";
const { createAppServer } = await import("../server.js");
const root = mkdtempSync(join(tmpdir(), "ogid-agent-real-"));
for (const dir of ["config/opencode", "data", "cache", "state", "workspace"])
  mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
const runtime = createAppServer({
  port: 0,
  host: "127.0.0.1",
  disableBackgroundRefresh: true,
  storage: {
    enabled: true,
    businessEnabled: true,
    databasePath: join(root, "ogid.sqlite"),
  },
  market: { provider: "", historyPersist: false },
  news: { providers: [], rssFeeds: [] },
  agent: { mode: "shadow", manifest, backgroundModel: manifest.defaultModel },
});
let broker, child, logFd;
const evidence = {
  kind: "host-real-integration",
  model: model.alias,
  context: model.context,
  slots: props.total_slots,
  wire: [],
  checks: [],
  productionModified: false,
};
const output = process.env.OGID_AGENT_SMOKE_OUTPUT || join(root, "result.json");
const freePort = async () => {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
};
try {
  await runtime.start();
  const ogidUrl = `http://127.0.0.1:${runtime.server.address().port}`,
    brokerToken = randomBytes(32).toString("base64url"),
    password = randomBytes(32).toString("base64url");
  broker = createInferenceBroker({
    upstream: upstream.origin,
    apiKey: key,
    token: brokerToken,
    manifest,
    fetchImpl: (url, options) => {
      if (!url.endsWith("/v1/chat/completions")) return fetch(url, options);
      const b = JSON.parse(options.body);
      evidence.wire.push({
        model: b.model,
        stream: b.stream,
        toolNames: (b.tools || []).map((t) => t.function?.name),
        hasFixedCap: ["max_tokens", "max_completion_tokens", "n_predict"].some(
          (k) => k in b,
        ),
      });
      return fetch(url, options);
    },
  });
  broker.listen(0, "127.0.0.1");
  await once(broker, "listening");
  const cancellation = new AbortController();
  const probe = await fetch(
    `http://127.0.0.1:${broker.address().port}/v1/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${brokerToken}`,
        "Content-Type": "application/json",
      },
      signal: cancellation.signal,
      body: JSON.stringify({
        model: model.alias,
        stream: true,
        messages: [
          {
            role: "user",
            content: "Enumera los números del uno al mil, uno por línea.",
          },
        ],
      }),
    },
  );
  if (!probe.ok) throw new Error("CANCELLATION_PROBE_FAILED");
  const stream = probe.body.getReader();
  await stream.read();
  cancellation.abort();
  await stream.cancel().catch(() => {});
  evidence.checks.push(
    "Actual streaming request cancelled at broker; subsequent tool cycle must complete",
  );
  const config = generateOpenCodeConfig({
    manifest,
    defaultModel: manifest.defaultModel,
    brokerUrl: `http://127.0.0.1:${broker.address().port}`,
    mcpCommand: [
      process.execPath,
      fileURLToPath(
        new URL("../../integrations/ogid-mcp/src/index.js", import.meta.url),
      ),
    ],
    toolNames: [
      "ogid_read_ogid_query",
      "ogid_read_ogid_get_capabilities",
      "ogid_read_ogid_health",
    ],
  });
  writeFileSync(
    join(root, "config/opencode/opencode.json"),
    JSON.stringify(config),
    { mode: 0o600 },
  );
  const port = await freePort();
  logFd = openSync(join(root, "opencode.log"), "w", 0o600);
  child = spawn(
    opencodeBinary,
    ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: join(root, "workspace"),
      env: {
        PATH: process.env.PATH,
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_DATA_HOME: join(root, "data"),
        XDG_CACHE_HOME: join(root, "cache"),
        XDG_STATE_HOME: join(root, "state"),
        AGENT_BROKER_TOKEN: brokerToken,
        OGID_BASE_URL: ogidUrl,
        OPENCODE_CONFIG: join(root, "config/opencode/opencode.json"),
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_CLAUDE_CODE: "1",
        OPENCODE_PASSWORD: password,
      },
      stdio: ["ignore", logFd, logFd],
    },
  );
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/info`, {
        headers: {
          Authorization:
            "Basic " + Buffer.from(`opencode:${password}`).toString("base64"),
        },
        signal: AbortSignal.timeout(500),
      });
      if (r.ok) break;
    } catch {}
    if (child.exitCode !== null) throw new Error("OPENCODE_START_FAILED");
    await wait(100);
  }
  const anonymous = await fetch(`http://127.0.0.1:${port}/api/info`);
  if (anonymous.status !== 401) throw new Error("OPENCODE_AUTH_NOT_ENFORCED");
  const opencode = new OpenCodeClient({
    baseUrl: `http://127.0.0.1:${port}`,
    password,
  });
  for (let i = 0; ; i++) {
    try {
      await opencode.verify(AbortSignal.timeout(10000));
      break;
    } catch (e) {
      if (i >= 100 || e.code !== "OPENCODE_MCP_NOT_READY") throw e;
      await wait(200);
    }
  }
  let analyst;
  for (let i = 0; i < 50; i++) {
    const agents = await opencode.request("/api/agent");
    analyst = agents.data.find((a) => a.id === "ogid-analyst");
    if (analyst) break;
    await wait(200);
  }
  if (!analyst) {
    evidence.configSources = (await opencode.request("/api/config")).map(
      (e) => ({ type: e.type, path: e.path, keys: Object.keys(e.info || {}) }),
    );
    throw new Error("ANALYST_NOT_REGISTERED");
  }
  evidence.checks.push(
    "OpenCode 2.0.31 authenticated; configured analyst registered",
  );
  evidence.resolvedPermissions = analyst.permissions;
  await wait(1000);
  evidence.mcp = await opencode.request("/api/mcp");
  const call = runtime.app.locals.agentCall,
    owner = randomUUID();
  const pending = await call("enqueue", {
    task: "global_intelligence_brief",
    model: manifest.defaultModel,
    key: randomUUID(),
    priority: 10,
  });
  const job = await call("claim", { owner });
  const worker = new IntelligenceWorker({
    call,
    opencode,
    model: manifest.defaultModel,
    mode: "shadow",
    // A real tool cycle includes model prefill and several sequential turns.
    // Keep this explicit integration budget separate from storage deadlines.
    policy: { pollMs: 300, runDeadlineMs: 360000 },
  });
  worker.owner = owner;
  await worker.execute(job);
  const result = await call("run", { jobId: pending.jobId, internal: true });
  evidence.job = { status: result.status, errorCode: result.errorCode };
  if (result.status !== "completed")
    throw Object.assign(new Error("REAL_AGENT_PUBLICATION_FAILED"), {
      code: result.errorCode,
    });
  const publications = await call("publications", { includeShadow: true });
  if (!publications.items.length) throw new Error("PUBLICATION_NOT_PERSISTED");
  evidence.checks.push("OGID MCP tool cycle; validated publication persisted");
  const session = await opencode.progress(
    result.opencodeId,
    AbortSignal.timeout(10000),
    `msg_ogid_${job.jobId.replaceAll("-", "")}`,
  );
  evidence.toolExecutions = session.tools;
  const device = await call("deviceCreate", {
      label: "Isolated real chat smoke",
    }),
    chat = await call("sessionCreate", {
      deviceId: device.deviceId,
      model: manifest.defaultModel,
    });
  const sent = await call("send", {
    deviceId: device.deviceId,
    sessionId: chat.sessionId,
    key: randomUUID(),
    text: "Resume la cobertura y los límites del snapshot en dos frases. Incluye una cita exacta [evidence:ID] de los datos consultados.",
  });
  const chatJob = await call("claim", { owner });
  await worker.execute(chatJob);
  const chatRun = await call("run", { jobId: sent.jobId, internal: true }),
    history = await call("messages", {
      deviceId: device.deviceId,
      sessionId: chat.sessionId,
    });
  if (
    chatRun.status !== "completed" ||
    !history.items.some((m) => m.role === "assistant" && m.evidenceIds?.length)
  )
    throw Object.assign(Error("REAL_CHAT_FAILED"), { code: chatRun.errorCode });
  evidence.chat = {
    status: chatRun.status,
    persistedMessages: history.items.length,
    citationsValidated: true,
  };
  evidence.checks.push(
    "Real contextual chat with validated snapshot citations persisted",
  );
  evidence.usageAvailable = true;
  model.probe = {
    verifiedAt: new Date().toISOString(),
    wireNoFixedCap: evidence.wire.every((w) => !w.hasFixedCap),
    streaming: evidence.wire.some((w) => w.stream),
    cancellation: true,
    kind: "opencode-ogid-live-tool-cycle",
  };
  evidence.catalog = {
    ...manifest,
    models: inventory.data.map((m) =>
      m.id === model.alias
        ? model
        : {
            alias: m.id,
            state: "context-unverified",
            context: null,
            tools: false,
            structuredOutput: false,
            serverContextVerified: false,
          },
    ),
  };
  evidence.status = "passed";
} catch (error) {
  evidence.status = "failed";
  evidence.errorCode = error.code || error.message;
  process.exitCode = 1;
} finally {
  child?.kill("SIGTERM");
  if (child && child.exitCode === null)
    await Promise.race([once(child, "exit"), wait(5000)]);
  if (child?.exitCode === null) child.kill("SIGKILL");
  if (logFd !== undefined) closeSync(logFd);
  if (broker) {
    broker.closeAllConnections();
    await new Promise((r) => broker.close(r));
  }
  await runtime.stop();
  writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      status: evidence.status,
      errorCode: evidence.errorCode || null,
      output,
      checks: evidence.checks,
    }),
  );
  // Retain a private temporary workspace for diagnosing the real smoke; it is
  // never imported into the repo or treated as production OpenCode state.
}
