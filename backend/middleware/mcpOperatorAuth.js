import { readFileSync, statSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { getOperation, operationPath, parseOperationQuery, validateValue } from "../contracts/ogidOperations.js";

export function readOperatorCredentials(file) {
  if (!file) return [];
  try {
    const stat = statSync(file);
    if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 16384) throw new Error();
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(data.credentials) || data.credentials.length > 20 || data.credentials.some(row => !/^[A-Za-z0-9_-]{32,256}$/.test(row.token || "") || !Array.isArray(row.scopes) || row.scopes.some(scope => typeof scope !== "string"))) throw new Error();
    return data.credentials;
  } catch {
    // JSON.parse y errores de filesystem pueden incluir texto del secreto o su ruta.
    throw new Error("Invalid MCP operator credentials: require private 600 file, valid bounded JSON and explicit scopes.");
  }
}
function matchToken(a, b) { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
export function mcpOperatorAuth(req, res, next) {
  const id = req.headers["x-ogid-mcp-operation"];
  if (!id) return next();
  const operation = getOperation(id);
  const token = /^Bearer /i.test(req.headers.authorization || "") ? req.headers.authorization.slice(7).trim() : "";
  const credentials = res.app.locals.mcpOperatorCredentials || [];
  const credential = credentials.find(row => matchToken(row.token, token));
  const requestPath = new URL(req.originalUrl, "http://local").pathname;
  const dynamic = operation?.path.includes(":id");
  const pathId = dynamic ? decodeURIComponent(requestPath.split("/").at(-1)) : null;
  let expectedPath;
  try { expectedPath = operation ? operationPath(operation, { id: pathId }) : null; } catch { expectedPath = null; }
  if (!operation || operation.profile !== "operator" || req.method !== operation.method || requestPath !== expectedPath || !credential?.scopes.includes(operation.scope))
    return res.status(403).json({ ok: false, error: { code: "MCP_OPERATOR_FORBIDDEN", message: "La operación requiere una credencial local con el permiso indicado." } });
  try {
    const query = { ...req.query };
    for (const [key, value] of Object.entries(operation.fixed)) { if (query[key] !== String(value)) throw new Error(); delete query[key]; }
    parseOperationQuery(query, operation);
    if (operation.body ? !validateValue(req.body || {}, operation.body) : req.body && Object.keys(req.body).length) throw new Error();
  } catch { return res.status(400).json({ ok: false, error: { code: "INVALID_OPERATOR_ARGUMENTS", message: "La solicitud no coincide con el contrato autorizado." } }); }
  req.mcpOperatorAuthorized = true;
  // Auditoría de autorización sin token, argumentos, URLs o cuerpos.
  res.app.locals.mcpOperatorAudit?.({ operationId: operation.id, method: operation.method, authorizedAt: new Date().toISOString() });
  return next();
}
