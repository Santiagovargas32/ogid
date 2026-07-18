const SENSITIVE_KEY_PATTERN = /^(?:api[-_]?key|access[-_]?key|token|access[-_]?token|authorization|secret|password|key|crumb|cookie|set[-_]?cookie)$/i;
const URL_SENSITIVE_KEYS = new Set(["apikey", "api_key", "access_key", "token", "access_token", "key", "secret", "password", "crumb", "cookie", "set-cookie", "set_cookie"]);

export const REDACTED_VALUE = "***";

export function sanitizeUrl(value = "") {
  const input = String(value || "");
  if (!input) return input;

  const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) || input.startsWith("/");
  if (!looksLikeUrl) {
    return input.replace(/([?&](?:api[-_]?key|access[-_]?key|token|access[-_]?token|key|secret|password|crumb|cookie|set[-_]?cookie)=)[^&#\s]*/gi, `$1${REDACTED_VALUE}`);
  }

  try {
    const url = new URL(input, input.startsWith("http") ? undefined : "http://local");
    for (const key of [...url.searchParams.keys()]) {
      if (URL_SENSITIVE_KEYS.has(String(key).toLowerCase())) url.searchParams.set(key, REDACTED_VALUE);
    }
    return input.startsWith("http") ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return input.replace(/([?&](?:api[-_]?key|access[-_]?key|token|access[-_]?token|key|secret|password|crumb|cookie|set[-_]?cookie)=)[^&#\s]*/gi, `$1${REDACTED_VALUE}`);
  }
}

function sanitizeString(value) {
  return sanitizeUrl(value)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED_VALUE}`)
    .replace(/\b((?:Set-)?Cookie\s*:\s*)[^\r\n]*/gi, `$1${REDACTED_VALUE}`)
    .replace(/\b((?:api[-_]?key|access[-_]?key|token|access[-_]?token|secret|password|cookie|set[-_]?cookie|crumb(?:\s+from\s+cookie\s+store)?)\s*[:=]\s*)[^\s,;]+/gi, `$1${REDACTED_VALUE}`);
}

export function sanitizeSensitiveData(value, seen = new WeakSet()) {
  if (typeof value === "string") return sanitizeString(value);
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeSensitiveData(entry, seen));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    SENSITIVE_KEY_PATTERN.test(key) ? REDACTED_VALUE : sanitizeSensitiveData(entry, seen)
  ]));
}
