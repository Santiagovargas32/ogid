import { isIP } from "node:net";

export function normalizeIp(value = "") {
  let normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }

  if (normalized.startsWith("[")) {
    const closingIndex = normalized.indexOf("]");
    if (closingIndex > 0) {
      normalized = normalized.slice(1, closingIndex);
    }
  }

  normalized = normalized.split("%")[0];

  const mappedMatch = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mappedMatch) {
    normalized = mappedMatch[1];
  }

  const ipv4WithPort = normalized.match(/^(\d+\.\d+\.\d+\.\d+):(\d+)$/);
  if (ipv4WithPort) {
    normalized = ipv4WithPort[1];
  }

  return isIP(normalized) ? normalized.toLowerCase() : "";
}

export function resolveClientIp(req) {
  const remoteAddress = normalizeIp(req?.socket?.remoteAddress || req?.connection?.remoteAddress || "");
  const expressIp = normalizeIp(req?.ip || "");
  const clientIp = remoteAddress || expressIp || null;

  return {
    clientIp,
    ip: clientIp,
    expressIp: expressIp || null,
    remoteAddress: remoteAddress || null
  };
}
