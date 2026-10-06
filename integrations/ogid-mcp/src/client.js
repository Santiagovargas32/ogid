import { getOperation, operationPath, validateValue } from "../../../backend/contracts/ogidOperations.js";
export class ReadError extends Error {
  constructor(code, message, transient = false) { super(message); this.code = code; this.transient = transient; }
}
const LEGACY = { "/api/health": "health", "/api/intel/news": "intel.news", "/api/intel/awareness-snapshot": "awareness" };
export function createReadClient(config, fetchImpl = fetch) {
  let active = 0; const waiting = [];
  async function slot() {
    if (active >= (config.maxConcurrent || 4)) {
      if (waiting.length >= 32) throw new ReadError("BUSY", "Demasiadas consultas MCP concurrentes.");
      await new Promise(resolve => waiting.push(resolve));
    } else active++;
  }
  function release() { if (waiting.length) waiting.shift()(); else active--; }
  async function request(operation, params, body, pathParams, legacy = false) {
    if (!validateValue(params, operation.parameters) || (operation.body ? !validateValue(body || {}, operation.body) : body !== undefined)
      || (operation.pathParameters && !validateValue(pathParams || {}, operation.pathParameters))) throw new ReadError("INVALID_ARGUMENTS", "Argumentos fuera del contrato de la operación.");
    if (params.from && params.to && Date.parse(params.from) > Date.parse(params.to)) throw new ReadError("INVALID_WINDOW", "from debe ser anterior o igual a to.");
    if (operation.profile === "operator" && (config.profile !== "operator" || !config.operatorCredential?.scopes.includes(operation.scope))) throw new ReadError("FORBIDDEN_REQUEST", "El perfil no autoriza esta operación.");
    const url = new URL(operationPath(operation, pathParams), config.baseUrl);
    for (const [key, value] of Object.entries({ ...params, ...operation.fixed })) url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
    await slot();
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), config.timeoutMs); let response;
        try {
          const headers = { Accept: "application/json" };
          if (operation.profile === "operator") { headers.Authorization = "Bearer " + config.operatorCredential.token; headers["x-ogid-mcp-operation"] = operation.id; }
          if (operation.body) headers["Content-Type"] = "application/json";
          response = await fetchImpl(url, { method: operation.method, headers, redirect: "error", signal: controller.signal, ...(operation.body ? { body: JSON.stringify(body || {}) } : {}) });
          if (!response.ok) {
            const allowed = new Set(["CURSOR_EXPIRED", "CURSOR_FILTER_MISMATCH", "INVALID_CURSOR", "NEWS_ITEM_TOO_LARGE", "NEWS_ITEM_NOT_FOUND", "UNRESOLVED_INSTRUMENT", "MCP_OPERATOR_FORBIDDEN", "OUTPUT_TOO_LARGE", "SNAPSHOT_TOO_LARGE"]);
            let code = legacy ? "UPSTREAM_HTTP" : response.status === 401 ? "UNAUTHORIZED" : response.status === 429 ? "RATE_LIMITED" : "UPSTREAM_HTTP";
            const chunks = []; let bytes = 0;
            for await (const chunk of response.body) { bytes += chunk.byteLength; if (bytes > 8192) break; chunks.push(Buffer.from(chunk)); }
            try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (allowed.has(value.error?.code)) code = value.error.code; } catch { /* no reflection */ }
            throw new ReadError(code, "OGID respondió HTTP " + response.status + (allowed.has(code) ? " (" + code + ")." : "."), operation.profile === "research" && operation.method === "GET" && [502, 503, 504].includes(response.status));
          }
          if (!/application\/json/i.test(response.headers.get("content-type") || "")) throw new ReadError("INVALID_RESPONSE", "OGID no devolvió JSON.");
          if (Number(response.headers.get("content-length")) > config.maxResponseBytes) throw new ReadError("RESPONSE_TOO_LARGE", "Respuesta de OGID demasiado grande; reduce el límite.");
          const chunks = []; let bytes = 0;
          for await (const chunk of response.body) { bytes += chunk.byteLength; if (bytes > config.maxResponseBytes) throw new ReadError("RESPONSE_TOO_LARGE", "Respuesta de OGID demasiado grande; reduce el límite."); chunks.push(Buffer.from(chunk)); }
          let value; try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ReadError("INVALID_RESPONSE", "JSON de OGID inválido."); }
          if (value?.ok !== true || !value.data || typeof value.data !== "object" || Array.isArray(value.data)) throw new ReadError("INVALID_RESPONSE", "Contrato de respuesta OGID inesperado.");
          return value.data;
        } catch (error) {
          const failure = error instanceof ReadError ? error : new ReadError(controller.signal.aborted ? "TIMEOUT" : "CONNECTION_FAILED", controller.signal.aborted ? "Tiempo de espera agotado consultando OGID." : "No se pudo leer OGID por loopback.", operation.profile === "research" && operation.method === "GET" && !controller.signal.aborted && ["ECONNRESET", "ECONNREFUSED", "EPIPE", "UND_ERR_SOCKET"].includes(error.cause?.code));
          if (attempt || !failure.transient) throw failure;
        } finally { clearTimeout(timer); if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } finally { release(); }
  }
  const read = async (route, params = {}) => {
    const operation = getOperation(LEGACY[route]);
    if (!operation) throw new ReadError("FORBIDDEN_REQUEST", "El adaptador solo permite las lecturas pactadas.");
    const clean = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
    if (!validateValue(clean, operation.parameters)) throw new ReadError("FORBIDDEN_REQUEST", "El adaptador solo permite las lecturas pactadas.");
    return request(operation, clean, undefined, undefined, true);
  };
  read.operation = async (id, params = {}, body, pathParams) => {
    const operation = getOperation(id);
    if (!operation) throw new ReadError("FORBIDDEN_REQUEST", "Operación no registrada.");
    return request(operation, params, body, pathParams);
  };
  return read;
}
