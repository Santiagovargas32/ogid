import { timingSafeEqual } from "node:crypto";
import { normalizeIp } from "../utils/clientIp.js";

function isLoopback(value = "") {
  const ip = normalizeIp(value);
  return ip === "127.0.0.1" || ip === "::1";
}

function isLanAddress(value = "") {
  const ip = normalizeIp(value);
  if (ip.includes(":")) return /^(?:f[cd][\da-f]{2}|fe[89ab][\da-f]):/.test(ip);
  const [first, second] = ip.split(".").map(Number);
  return first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254);
}

function readPresentedToken(req) {
  const authorization = String(req.headers.authorization || "");
  if (/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, "").trim();
  return String(req.headers["x-admin-token"] || "").trim();
}

function tokensMatch(expected, presented) {
  const expectedBuffer = Buffer.from(String(expected || ""));
  const presentedBuffer = Buffer.from(String(presented || ""));
  return expectedBuffer.length > 0 && expectedBuffer.length === presentedBuffer.length && timingSafeEqual(expectedBuffer, presentedBuffer);
}

function isSensitiveRequest(req) {
  if (req.path === "/admin" || req.path.startsWith("/admin/") || req.path === "/api/admin" || req.path.startsWith("/api/admin/")) return true;
  if (!new Set(["GET", "HEAD", "OPTIONS"]).has(req.method)) return true;
  const force = String(req.query?.force || "").toLowerCase();
  return force === "1" || force === "true";
}

export function sensitiveRouteAuth(req, res, next) {
  if (req.mcpOperatorAuthorized === true) return next();
  if (!isSensitiveRequest(req)) return next();
  const security = res.app.locals.config?.security || {};
  const remoteAddress = req.clientIpInfo?.remoteAddress || req.socket?.remoteAddress || req.ip || "";
  const localAllowed = security.allowLocalAdmin !== false && isLoopback(remoteAddress);
  const lanAllowed = security.allowLanAdmin === true && isLanAddress(remoteAddress);
  const tokenAllowed = tokensMatch(security.adminApiToken, readPresentedToken(req));
  if (localAllowed || lanAllowed || tokenAllowed) return next();
  return res.status(401).json({ ok: false, error: { code: "ADMIN_AUTH_REQUIRED", message: "Authentication is required for this operation." } });
}
