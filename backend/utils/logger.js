import { randomUUID } from "node:crypto";
import { resolveClientIp } from "./clientIp.js";
import { sanitizeSensitiveData, sanitizeUrl } from "./sanitize.js";

const LEVEL_PRIORITY = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};
const RECENT_LOG_LIMIT = 200;
const recentLogs = [];

const configuredLevel = String(process.env.LOG_LEVEL || "info").trim().toLowerCase();
const DEFAULT_SCOPE = "app";

function shouldLog(level) {
  const selected = LEVEL_PRIORITY[configuredLevel] ?? LEVEL_PRIORITY.info;
  const incoming = LEVEL_PRIORITY[level] ?? LEVEL_PRIORITY.info;
  return incoming <= selected;
}

function emit(level, message, context = {}, scope = DEFAULT_SCOPE) {
  if (!shouldLog(level)) {
    return;
  }

  const sanitizedContext = sanitizeSensitiveData(context);
  const details = sanitizedContext && typeof sanitizedContext === "object" && !Array.isArray(sanitizedContext)
    ? { ...sanitizedContext }
    : {};
  const contextMessage = details.message;
  delete details.timestamp;
  delete details.level;
  delete details.scope;
  delete details.message;
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    scope: scope || DEFAULT_SCOPE,
    message,
    ...details
  };
  if (contextMessage !== undefined && payload.errorMessage === undefined && contextMessage !== message) {
    payload.errorMessage = contextMessage;
  }

  if (level === "warn" || level === "error") {
    recentLogs.push(payload);
    if (recentLogs.length > RECENT_LOG_LIMIT) {
      recentLogs.splice(0, recentLogs.length - RECENT_LOG_LIMIT);
    }
  }

  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
}

export const log = {
  info: (message, context) => emit("info", message, context, DEFAULT_SCOPE),
  warn: (message, context) => emit("warn", message, context, DEFAULT_SCOPE),
  error: (message, context) => emit("error", message, context, DEFAULT_SCOPE),
  debug: (message, context) => emit("debug", message, context, DEFAULT_SCOPE)
};

export function createLogger(scope) {
  const loggerScope = String(scope || DEFAULT_SCOPE);
  return {
    info: (message, context) => emit("info", message, context, loggerScope),
    warn: (message, context) => emit("warn", message, context, loggerScope),
    error: (message, context) => emit("error", message, context, loggerScope),
    debug: (message, context) => emit("debug", message, context, loggerScope)
  };
}

export function getRecentLogs({ limit = 20, levels = ["warn", "error"] } = {}) {
  const allowedLevels = new Set((Array.isArray(levels) ? levels : [levels]).map((value) => String(value || "")));
  return recentLogs
    .filter((entry) => allowedLevels.has(entry.level))
    .slice(-Math.max(1, Number.parseInt(String(limit ?? 20), 10) || 20))
    .map((entry) => ({ ...entry }));
}

const requestLog = createLogger("backend/utils/logger#request");

export function requestLogger(req, res, next) {
  const suppliedId=req.headers['x-request-id'];
  const requestId = typeof suppliedId==='string' && /^[A-Za-z0-9._:-]{1,128}$/.test(suppliedId) ? suppliedId : randomUUID();
  const started = process.hrtime.bigint();
  const clientIpInfo = resolveClientIp(req);

  req.requestId = requestId;
  req.clientIpInfo = clientIpInfo;
  res.setHeader("x-request-id", requestId);
  requestLog.debug('http_request_started',{requestId,method:req.method,path:sanitizeUrl(req.originalUrl)});

  let recorded=false;
  const record = outcome => {
    if(recorded)return;recorded=true;
    if(res.locals?.resourceDeferred)return;
    const ended = process.hrtime.bigint();
    const durationMs = Number(ended - started) / 1_000_000;
    requestLog.info("http_request", {
      requestId,
      method: req.method,
      path: sanitizeUrl(req.originalUrl),
      route:req.route?.path?`${req.baseUrl||''}${req.route.path}`:null,
      resource:typeof req.query?.resource==='string' && /^[a-zA-Z]{1,40}$/.test(req.query.resource)?req.query.resource:null,
      revision:Number.isSafeInteger(Number(req.query?.revision))?Number(req.query.revision):null,
      statusCode: res.statusCode,
      outcome,
      durationMs: Number(durationMs.toFixed(2)),
      ip: clientIpInfo.clientIp || req.ip || null,
      clientIp: clientIpInfo.clientIp,
      remoteAddress: clientIpInfo.remoteAddress,
      userAgent: req.headers["user-agent"] || null,
      origin: req.headers.origin || null,
      referer: sanitizeUrl(req.headers.referer || req.headers.referrer || "") || null
    });
  };
  res.on('finish',()=>record('finished'));
  res.on('close',()=>record(res.writableFinished?'finished':'aborted'));

  next();
}
