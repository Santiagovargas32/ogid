import { localUrl } from "./config.js";
import { agentError } from "./contracts.js";
import { setTimeout as wait } from "node:timers/promises";

// Reads and a fenced lease renewal can be repeated after a lost response.
// Admission, publication, state changes and inference remain single-attempt.
const repeatable = new Set(["status","run","memory","evidence","evidenceChunk","clusters","workerHealth","reconcileCandidates","pendingCancellations","heartbeat"]);

// Worker credential grants only the typed internal operations, never admin.
export function createAgentInternalClient({
  baseUrl,
  token,
  fetchImpl = fetch,
}) {
  const base = localUrl(baseUrl).origin;
  if (!token) throw agentError("AGENT_WORKER_TOKEN_REQUIRED");
  return async (method, args = {}) => {
    if (!/^[A-Za-z]+$/.test(method))
      throw agentError("AGENT_INVALID_OPERATION");
    for (let attempt=0; ;attempt++) {
      try {
        const r = await fetchImpl(`${base}/api/agent/v1/internal/${method}`, {
          method: "POST",
          signal: AbortSignal.timeout(method === "snapshot" ? 390000 : ["evidence","evidenceChunk","clusters","memory"].includes(method) ? 190000 : 30000),
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(args),
        });
        const value = await r.json();
        if (!r.ok) {
          const code = /^(AGENT|FORECAST|OPENCODE)_[A-Z0-9_]+$/.test(value.error?.code || "")
            ? value.error.code : `AGENT_INTERNAL_HTTP_${r.status}`;
          const raw=value.error?.details;
          const details=code==='AGENT_UNVERIFIED_NUMBER' && raw && typeof raw.evidenceId==='string' && typeof raw.path==='string'
            ? {evidenceId:raw.evidenceId.slice(0,256),path:raw.path.slice(0,256),expectedValue:typeof raw.expectedValue==='number'&&Number.isFinite(raw.expectedValue)?raw.expectedValue:null,reason:raw.reason==='exact-value-required'?'exact-value-required':'numeric-path-not-found'}
            : code==='AGENT_UNKNOWN_EVIDENCE' && typeof raw?.evidenceId==='string'?{evidenceId:raw.evidenceId.slice(0,256),reason:'not-in-snapshot'}:null;
          throw agentError(code, r.status,details);
        }
        return value.data;
      } catch(error) {
        const transport=["AbortError","TimeoutError","TypeError"].includes(error.name);
        if(attempt===0 && repeatable.has(method) && (transport || error.code === "AGENT_INTERNAL_HTTP_503")) {
          await wait(500);continue;
        }
        if(transport)throw agentError("AGENT_INTERNAL_TRANSPORT_UNAVAILABLE",503);
        throw error;
      }
    }
  };
}
