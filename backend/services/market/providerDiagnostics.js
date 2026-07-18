import { sanitizeSensitiveData, sanitizeUrl } from "../../utils/sanitize.js";

export function sanitizeRequestUrl(value = "") {
  return sanitizeUrl(value);
}

export function sanitizeRequestUrls(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => sanitizeRequestUrl(value)).filter(Boolean))];
}

export function buildResponsePreview(payload, maxLength = 240) {
  if (payload === undefined || payload === null) {
    return null;
  }

  const text =
    typeof payload === "string"
      ? payload
      : (() => {
          try {
            return JSON.stringify(payload);
          } catch {
            return String(payload);
          }
        })();

  const normalized = String(sanitizeSensitiveData(text) || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}
