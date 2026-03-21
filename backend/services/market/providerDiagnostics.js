function normalizeUrl(value = "") {
  try {
    const url = new URL(String(value || ""));
    for (const key of ["apikey", "apiKey", "token", "key"]) {
      if (url.searchParams.has(key)) {
        url.searchParams.set(key, "***");
      }
    }
    return url.toString();
  } catch {
    return String(value || "");
  }
}

export function sanitizeRequestUrl(value = "") {
  return normalizeUrl(value);
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

  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}
