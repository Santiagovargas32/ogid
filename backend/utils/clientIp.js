import { BlockList, isIP } from "node:net";

function toInt(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseTrustProxySetting(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => String(item || "").trim()).filter(Boolean);
    return items.length ? items : fallback;
  }

  const normalized = String(value || "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  const numeric = toInt(normalized);
  if (Number.isFinite(numeric)) {
    return numeric;
  }

  const csv = String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return csv.length <= 1 ? csv[0] || fallback : csv;
}

export function isTrustedProxyEnabled(setting = false) {
  if (setting === true) {
    return true;
  }
  if (typeof setting === "number") {
    return setting > 0;
  }
  if (Array.isArray(setting)) {
    return setting.length > 0;
  }
  return Boolean(String(setting || "").trim());
}

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

export function parseForwardedFor(value = "") {
  return String(value || "")
    .split(",")
    .map((entry) => normalizeIp(entry))
    .filter(Boolean);
}

export function resolveClientIp(req, { trustProxy = null } = {}) {
  const configuredTrustProxy = trustProxy ?? req?.app?.locals?.config?.security?.trustProxy ?? false;
  const trustedProxy = isTrustedProxyEnabled(configuredTrustProxy);
  const remoteAddress = normalizeIp(req?.socket?.remoteAddress || req?.connection?.remoteAddress || "");
  const expressIp = normalizeIp(req?.ip || "");
  const forwardedFor = trustedProxy ? parseForwardedFor(req?.headers?.["x-forwarded-for"]) : [];
  const cfConnectingIp = trustedProxy ? normalizeIp(req?.headers?.["cf-connecting-ip"] || "") : "";
  const xRealIp = trustedProxy ? normalizeIp(req?.headers?.["x-real-ip"] || "") : "";
  const clientIp = cfConnectingIp || forwardedFor[0] || xRealIp || expressIp || remoteAddress || null;

  return {
    trustedProxy,
    clientIp,
    ip: clientIp,
    expressIp: expressIp || null,
    forwardedFor,
    remoteAddress: remoteAddress || null,
    cfConnectingIp: cfConnectingIp || null,
    xRealIp: xRealIp || null
  };
}

function normalizeAllowlistEntries(entries = []) {
  if (typeof entries === "string") {
    return entries
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return (Array.isArray(entries) ? entries : [])
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
}

export function compileIpAllowlist(entries = []) {
  const normalizedEntries = normalizeAllowlistEntries(entries);
  const blockList = new BlockList();
  const invalidEntries = [];

  for (const entry of normalizedEntries) {
    if (entry.includes("/")) {
      const [networkRaw, prefixRaw] = entry.split("/", 2);
      const network = normalizeIp(networkRaw);
      const prefix = toInt(prefixRaw);
      const type = isIP(network);
      const maxPrefix = type === 4 ? 32 : type === 6 ? 128 : 0;

      if (!network || !Number.isFinite(prefix) || prefix < 0 || prefix > maxPrefix) {
        invalidEntries.push(entry);
        continue;
      }

      blockList.addSubnet(network, prefix, type === 4 ? "ipv4" : "ipv6");
      continue;
    }

    const address = normalizeIp(entry);
    const type = isIP(address);
    if (!address || !type) {
      invalidEntries.push(entry);
      continue;
    }

    blockList.addAddress(address, type === 4 ? "ipv4" : "ipv6");
  }

  return {
    entries: normalizedEntries,
    invalidEntries,
    enabled: normalizedEntries.length > 0,
    isAllowed(ip) {
      const address = normalizeIp(ip);
      const type = isIP(address);
      if (!address || !type) {
        return false;
      }
      return blockList.check(address, type === 4 ? "ipv4" : "ipv6");
    }
  };
}
