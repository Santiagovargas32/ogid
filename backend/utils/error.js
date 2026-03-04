import { createLogger } from "./logger.js";

const log = createLogger("backend/utils/error");

export class AppError extends Error {
  constructor(message, statusCode = 500, code = "INTERNAL_ERROR", details = null) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function notFoundHandler(req, _res, next) {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404, "NOT_FOUND"));
}

export function errorHandler(error, req, res, _next) {
  const statusCode = error.statusCode && Number.isInteger(error.statusCode) ? error.statusCode : 500;
  const code = error.code || "INTERNAL_ERROR";
  const message = statusCode < 500 ? error.message : "Internal server error";

  log.error("request_failed", {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl,
    statusCode,
    code,
    details: error.details || null,
    stack: statusCode >= 500 ? error.stack : undefined
  });

  res.status(statusCode).json({
    ok: false,
    error: {
      code,
      message,
      details: error.details || null,
      requestId: req.requestId
    }
  });
}
