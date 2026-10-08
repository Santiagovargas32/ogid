import { captureBuildIdentity } from "../../../backend/utils/buildIdentity.js";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync, statSync } from "node:fs";

export const VERSION = "0.2.0";
export const ADAPTER_BUILD = captureBuildIdentity("adapter", VERSION);
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function boundedInteger(value, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new Error("Configuración numérica MCP fuera de rango.");
  }
  return Number(value);
}

export function loadConfig(env = process.env) {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error("El adaptador exige validación TLS.");
  }
  const url = new URL(env.OGID_BASE_URL || "http://127.0.0.1:3000");
  // Literales IP: evita resolución DNS, rebinding y direcciones no locales.
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("OGID_BASE_URL debe ser un origen loopback literal sin credenciales, ruta ni parámetros.");
  }
  const instrumentIds = [...new Set((env.OGID_INSTRUMENT_IDS || "").split(",").map(s => s.trim()).filter(Boolean))];
  const profile = env.OGID_PROFILE || "research";
  const instrumentAuth = env.OGID_INSTRUMENT_AUTH || "allowlist";
  if (!["research", "operator"].includes(profile) || !["allowlist", "runtime"].includes(instrumentAuth)) throw new Error("Perfil o autorización MCP inválidos.");
  let operatorCredential = null;
  if (profile === "operator") {
    const file = env.OGID_OPERATOR_CREDENTIAL_FILE;
    if (!file) throw new Error("El perfil operador requiere un archivo privado de credenciales.");
    const stat = statSync(file);
    if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 16384) throw new Error("Credencial MCP no privada o fuera de rango.");
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(value.token || "") || !Array.isArray(value.scopes) || value.scopes.some(scope => typeof scope !== "string")) throw new Error("Credencial MCP sin permisos válidos.");
    operatorCredential = Object.freeze({ token: value.token, scopes: Object.freeze(value.scopes) });
  }
  if (instrumentIds.length > 50 || instrumentIds.some(id => !/^[A-Za-z0-9._:^=/-]{1,128}$/.test(id))) {
    throw new Error("OGID_INSTRUMENT_IDS debe contener IDs verificados válidos.");
  }
  let commit = null;
  try {
    const head = execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1000 }).trim();
    if (/^[a-f0-9]{40,64}$/.test(head)) commit = head;
  } catch { /* Una distribución sin .git no acredita un commit. */ }
  return Object.freeze({
    baseUrl: url.origin,
    timeoutMs: boundedInteger(env.OGID_TIMEOUT_MS, 5000, 100, 30000),
    maxResponseBytes: boundedInteger(env.OGID_MAX_RESPONSE_BYTES, 2097152, 1024, 4194304),
    maxOutputBytes: boundedInteger(env.OGID_MAX_OUTPUT_BYTES, 262144, 4096, 524288),
    instrumentIds: Object.freeze(instrumentIds), commit, profile, instrumentAuth, operatorCredential,
    maxConcurrent: boundedInteger(env.OGID_MAX_CONCURRENT, 4, 1, 8)
  });
}
