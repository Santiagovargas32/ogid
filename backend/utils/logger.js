import { randomUUID } from "node:crypto";

const LEVEL_PRIORITY = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

const configuredLevel = String(process.env.LOG_LEVEL || "info").toLowerCase();
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

  const payload = {
    timestamp: new Date().toISOString(),
    level,
    scope: scope || DEFAULT_SCOPE,
    message,
    ...context
  };

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

const requestLog = createLogger("backend/utils/logger#request");

export function requestLogger(req, res, next) {
  const requestId = req.headers["x-request-id"] || randomUUID();
  const started = process.hrtime.bigint();

  req.requestId = requestId;
  res.setHeader("x-request-id", requestId);

  res.on("finish", () => {
    const ended = process.hrtime.bigint();
    const durationMs = Number(ended - started) / 1_000_000;
    requestLog.info("http_request", {
      requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Number(durationMs.toFixed(2)),
      ip: req.ip
    });
  });

  next();
}
