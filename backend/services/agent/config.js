import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentError, TASKS } from "./contracts.js";
export const AGENT_POLICY = Object.freeze({
  leaseMs: 90000,
  heartbeatMs: 20000,
  pollMs: 2000,
  reconcileMs: 60000,
  runDeadlineMs: 1800000,
  maxAttempts: 3,
  maxToolRepeat: 3,
  maxResponseBytes: 2097152,
  maxQueue: 128,
});
export function localUrl(value) {
  const u = new URL(value);
  if (
    !["http:", "https:"].includes(u.protocol) ||
    !["127.0.0.1", "[::1]", "localhost"].includes(u.hostname) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  )
    throw agentError("AGENT_NONLOCAL_ENDPOINT");
  return u;
}
export function readyModel(m) {
  return Boolean(
    m &&
    m.state === "ready" &&
    m.tools === true &&
    m.structuredOutput === true &&
    m.serverContextVerified === true &&
    Number.isSafeInteger(m.context) &&
    m.context > 0 &&
    m.probe?.verifiedAt &&
    m.probe?.wireNoFixedCap === true &&
    m.probe?.streaming === true &&
    m.probe?.cancellation === true,
  );
}
export function loadAgentConfig(env = process.env, override = {}) {
  const mode = override.mode || env.AGENT_MODE || "off";
  if (!["off", "shadow", "visible"].includes(mode))
    throw agentError("AGENT_INVALID_MODE");
  let manifest = override.manifest || {
    schemaVersion: "ogid-model-catalog-v1",
    models: [],
  };
  if (env.AGENT_MODEL_MANIFEST && !override.manifest && (mode!=="off" || existsSync(resolve(fileURLToPath(new URL("../../",import.meta.url)),env.AGENT_MODEL_MANIFEST))))
    manifest = JSON.parse(readFileSync(resolve(fileURLToPath(new URL("../../", import.meta.url)),env.AGENT_MODEL_MANIFEST), "utf8"));
  if (
    manifest.schemaVersion !== "ogid-model-catalog-v1" ||
    !Array.isArray(manifest.models)
  )
    throw agentError("AGENT_INVALID_CATALOG");
  const suppliedModes =
    override.taskModes || JSON.parse(env.AGENT_TASK_MODES || "{}");
  if (
    !suppliedModes ||
    typeof suppliedModes !== "object" ||
    Array.isArray(suppliedModes) ||
    Object.entries(suppliedModes).some(
      ([k, v]) =>
        !TASKS.includes(k) || !["off", "shadow", "visible"].includes(v),
    )
  )
    throw agentError("AGENT_INVALID_TASK_MODES");
  if (
    new Set(manifest.models.map((m) => m.alias)).size !==
      manifest.models.length ||
    manifest.models.some(
      (m) =>
        typeof m.alias !== "string" ||
        !/^[A-Za-z0-9._:-]{1,160}$/.test(m.alias),
    )
  )
    throw agentError("AGENT_INVALID_CATALOG");
  const taskModes = Object.fromEntries(
    TASKS.map((task) => [
      task,
      mode === "off" ? "off" : suppliedModes[task] || mode,
    ]),
  );
  const backgroundModel =
    override.backgroundModel ||
    env.AGENT_BACKGROUND_MODEL ||
    manifest.defaultModel ||
    null;
  const publicOrigin = override.publicOrigin || env.OGID_PUBLIC_ORIGIN || null;
  if (publicOrigin) {
    const u = new URL(publicOrigin);
    if (
      !["http:", "https:"].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.pathname !== "/" ||
      u.search ||
      u.hash
    )
      throw agentError("AGENT_INVALID_PUBLIC_ORIGIN");
  }
  return {
    mode,
    publicOrigin: publicOrigin ? new URL(publicOrigin).origin : null,
    manifest,
    backgroundModel,
    internalToken: env.AGENT_WORKER_TOKEN || "",
    brokerToken: env.AGENT_BROKER_TOKEN || "",
    opencodePassword: env.OGID_OPENCODE_PASSWORD || "",
    opencodeUrl: localUrl(env.OGID_OPENCODE_URL || "http://127.0.0.1:4096")
      .origin,
    brokerUrl: localUrl(env.AGENT_BROKER_URL || "http://127.0.0.1:4097").origin,
    managed: Object.fromEntries(["broker","opencode","worker"].map(name=>{
      const value=String(env[`AGENT_${name.toUpperCase()}_ENABLED`] || "off").toLowerCase();
      if(!["on","off"].includes(value))throw agentError("AGENT_INVALID_COMPONENT_SWITCH");
      return [name,value==="on"];
    })),
    ...override,
    taskModes,
  };
}
export function publicCapabilities(config) {
  return {
    schemaVersion: "ogid-agent-capabilities-v1",
    mode: config.mode,
    taskModes: config.taskModes,
    contextPolicy: "server-context",
    generationContract:{transport:'opencode-2.0.31',structuredGeneration:false,reason:'Pinned prompt transport accepts textual contracts; model structured-output capability is separate.'},
    localQuota: null,
    experimental: true,
    health: config.health || {
      state: config.mode === "off" ? "disabled" : "configured",
    },
    backgroundModel: config.backgroundModel,
    models: config.manifest.models.map((m) => ({
      id: `llamacpp/${m.alias}`,
      alias: m.alias,
      context: m.context || null,
      tools: m.tools === true,
      ready: readyModel(m),
      state: readyModel(m) ? "ready" : m.state || "context-unverified",
    })),
    evaluation: {
      horizonHours: 24,
      method: "daily-close-proxy",
      intraday: "unavailable",
      probabilityCalibrated: false,
    },
  };
}

export function taskMode(config, task) {
  return config.mode === "off"
    ? "off"
    : config.taskModes?.[task] || config.mode;
}
