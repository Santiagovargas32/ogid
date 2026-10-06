const ROUTES = new Set(["/api/health", "/api/intel/news", "/api/intel/awareness-snapshot"]);
const PARAMS = {
  "/api/health": new Set(),
  "/api/intel/news": new Set(["countries", "sources", "limit"]),
  "/api/intel/awareness-snapshot": new Set(["domain", "kinds", "status", "countries", "instrumentIds", "from", "to", "limit"])
};

export class ReadError extends Error {
  constructor(code, message, transient = false) {
    super(message);
    this.code = code;
    this.transient = transient;
  }
}

export function createReadClient(config, fetchImpl = fetch) {
  return async function read(route, params = {}) {
    if (!ROUTES.has(route) || Object.keys(params).some(key => !PARAMS[route].has(key))) {
      throw new ReadError("FORBIDDEN_REQUEST", "El adaptador solo permite las lecturas pactadas.");
    }
    const url = new URL(route, config.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      let response;
      try {
        response = await fetchImpl(url, {
          method: "GET", redirect: "error", signal: controller.signal,
          headers: { Accept: "application/json" }
        });
        if (!response.ok) {
          throw new ReadError("UPSTREAM_HTTP", `OGID respondió HTTP ${response.status}.`, [502, 503, 504].includes(response.status));
        }
        if (!/application\/json/i.test(response.headers.get("content-type") || "")) {
          throw new ReadError("INVALID_RESPONSE", "OGID no devolvió JSON.");
        }
        if (Number(response.headers.get("content-length")) > config.maxResponseBytes) {
          throw new ReadError("RESPONSE_TOO_LARGE", "Respuesta de OGID demasiado grande; reduce el límite.");
        }
        const chunks = [];
        let bytes = 0;
        for await (const chunk of response.body) {
          bytes += chunk.byteLength;
          if (bytes > config.maxResponseBytes) throw new ReadError("RESPONSE_TOO_LARGE", "Respuesta de OGID demasiado grande; reduce el límite.");
          chunks.push(Buffer.from(chunk));
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { throw new ReadError("INVALID_RESPONSE", "JSON de OGID inválido."); }
        if (body?.ok !== true || !body.data || typeof body.data !== "object" || Array.isArray(body.data)) {
          throw new ReadError("INVALID_RESPONSE", "Contrato de respuesta OGID inesperado.");
        }
        return body.data;
      } catch (error) {
        const failure = error instanceof ReadError ? error : new ReadError(
          controller.signal.aborted ? "TIMEOUT" : "CONNECTION_FAILED",
          controller.signal.aborted ? "Tiempo de espera agotado consultando OGID." : "No se pudo leer OGID por loopback.",
          // No reintentar redirecciones ni errores de TLS; un fallo de conexión sí.
          !controller.signal.aborted && ["ECONNRESET", "ECONNREFUSED", "EPIPE", "UND_ERR_SOCKET"].includes(error.cause?.code)
        );
        if (attempt || !failure.transient) throw failure;
      } finally {
        clearTimeout(timer);
        if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
}
