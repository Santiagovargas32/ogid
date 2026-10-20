import "../config/loadEnvironment.js";
import { loadAgentConfig } from "../services/agent/config.js";
import { createInferenceBroker } from "../services/agent/broker.js";
const config = loadAgentConfig();
const server = createInferenceBroker({
  token: config.brokerToken,
  apiKey: process.env.LLAMACPP_API_KEY,
  upstream: process.env.LLAMACPP_BASE_URL || "http://127.0.0.1:8080",
  manifest: config.manifest,
  managedModels:true,
});
server.listen(Number(new URL(config.brokerUrl).port || 80), "127.0.0.1");
let stopping=false;
function stop() {
  if(stopping)return;stopping=true;
  server.close(()=>{if(process.connected)process.disconnect();});
  setTimeout(() => server.closeAllConnections(), 10000).unref();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
if(process.env.OGID_MANAGED_CHILD === "1")process.once("disconnect",stop);
