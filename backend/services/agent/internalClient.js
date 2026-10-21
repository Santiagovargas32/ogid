import { localUrl } from "./config.js";
import { agentError } from "./contracts.js";
import { setTimeout as wait } from "node:timers/promises";

// Reads and a fenced lease renewal can be repeated after a lost response.
// Admission, publication, state changes and inference remain single-attempt.
const repeatable = new Set(["status","run","memory","evidence","evidenceChunk","clusters","workerHealth","reconcileCandidates","pendingCancellations","heartbeat"]);

// Worker credential grants only the typed internal operations, never admin.
export const internalDeadline=method=>method==="snapshot"?395000:["evidence","evidenceChunk","clusters","memory"].includes(method)?185000:method==="heartbeat"?50000:125000;
export function createAgentInternalClient({
  baseUrl,
  token,
  fetchImpl = fetch,
}) {
  const base = localUrl(baseUrl).origin;
  if (!token) throw agentError("AGENT_WORKER_TOKEN_REQUIRED");
  return async (method, args = {}, { signal } = {}) => {
    signal?.throwIfAborted();
    if (!/^[A-Za-z]+$/.test(method))
      throw agentError("AGENT_INVALID_OPERATION");
    const operationSignal=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(internalDeadline(method))]);
    for (let attempt=0; ;attempt++) {
      try {
        const r = await fetchImpl(`${base}/api/agent/v1/internal/${method}`, {
          method: "POST",
          signal: operationSignal,
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
            : ['AGENT_STALE_EVIDENCE','AGENT_SYNTHETIC_EVIDENCE','AGENT_FALLBACK_EVIDENCE','AGENT_UNKNOWN_EVIDENCE'].includes(code) && typeof raw?.evidenceId==='string'?{evidenceId:raw.evidenceId.slice(0,256),reason:code==='AGENT_UNKNOWN_EVIDENCE'?'not-in-snapshot':code}:null;
          throw agentError(code, r.status,details);
        }
        return value.data;
      } catch(error) {
        signal?.throwIfAborted();
        const transport=["AbortError","TimeoutError","TypeError"].includes(error.name);
        if(attempt===0 && !operationSignal.aborted && repeatable.has(method) && (transport || error.code === "AGENT_INTERNAL_HTTP_503")) {
          await wait(500, undefined, { signal:operationSignal }).catch(()=>{signal?.throwIfAborted();throw agentError("AGENT_INTERNAL_TRANSPORT_UNAVAILABLE",503);});continue;
        }
        if(transport)throw agentError("AGENT_INTERNAL_TRANSPORT_UNAVAILABLE",503);
        throw error;
      }
    }
  };
}
