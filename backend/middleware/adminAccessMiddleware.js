import { createLogger } from "../utils/logger.js";
import { resolveClientIp } from "../utils/clientIp.js";

const log = createLogger("backend/middleware/adminAccessMiddleware");

function buildApiForbiddenResponse() {
  return {
    ok: false,
    error: {
      code: "ADMIN_IP_FORBIDDEN",
      message: "Admin access is not allowed from this IP address."
    }
  };
}

export function createAdminAccessMiddleware() {
  return function adminAccessMiddleware(req, res, next) {
    const security = req.app?.locals?.config?.security || {};
    const allowlist = security.adminIpAllowlistMatcher;

    if (!allowlist?.enabled) {
      next();
      return;
    }

    const clientIpInfo = req.clientIpInfo || resolveClientIp(req, { trustProxy: security.trustProxy });
    req.clientIpInfo = clientIpInfo;

    if (allowlist.isAllowed(clientIpInfo.clientIp)) {
      next();
      return;
    }

    log.warn("admin_access_denied", {
      method: req.method,
      path: req.originalUrl,
      ip: clientIpInfo.clientIp,
      clientIp: clientIpInfo.clientIp,
      forwardedFor: clientIpInfo.forwardedFor,
      remoteAddress: clientIpInfo.remoteAddress
    });

    if (req.originalUrl?.startsWith("/api/")) {
      res.status(403).json(buildApiForbiddenResponse());
      return;
    }

    res.status(403).type("text/plain").send("Forbidden");
  };
}
