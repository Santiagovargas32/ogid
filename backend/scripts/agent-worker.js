import "../config/loadEnvironment.js";
import {
  loadAgentConfig,
  readyModel,
  localUrl,
} from "../services/agent/config.js";
import { IntelligenceWorker } from "../services/agent/worker.js";
import { OpenCodeClient } from "../services/agent/opencodeClient.js";
import { createAgentInternalClient } from "../services/agent/internalClient.js";
const config = loadAgentConfig();
if (config.mode === "off") {
  console.log("Agent worker disabled");
  process.exit(0);
}
if (
  !config.internalToken ||
  !config.opencodePassword ||
  !readyModel(
    config.manifest.models.find(
      (m) => `llamacpp/${m.alias}` === config.backgroundModel,
    ),
  )
)
  throw new Error("AGENT_PREFLIGHT_REQUIRED");
const base = localUrl(
  process.env.OGID_INTERNAL_URL || "http://127.0.0.1:3000",
).origin;
const call = createAgentInternalClient({
  baseUrl: base,
  token: config.internalToken,
});
const worker = new IntelligenceWorker({
  call,
  opencode: new OpenCodeClient({
    baseUrl: config.opencodeUrl,
    password: config.opencodePassword,
  }),
  model: config.backgroundModel,
  mode: config.mode,
  onProgress: (sessionId, progress) => {
    if (sessionId)
      return call("progress", { sessionId, ...progress }).catch(() => {});
  },
});
process.once("SIGTERM", () => worker.stop());
process.once("SIGINT", () => worker.stop());
if(process.env.OGID_MANAGED_CHILD === "1")process.once("disconnect",()=>worker.stop());
await worker.run();
if(process.connected)process.disconnect();
