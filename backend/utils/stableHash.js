import { createHash } from "node:crypto";
export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, stableValue(value[key])]));
  return value;
}
export const stableHash = value => createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
export function normalizeNewsFilters(input = {}) {
  const out = { timeField: "publishedAt" };
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      const normalized = value.map(item => String(item).trim()).filter(Boolean).map(item => ["symbols", "countries"].includes(key) ? item.toUpperCase() : key === "instrumentIds" ? item.toLowerCase() : item);
      if (normalized.length) out[key] = [...new Set(normalized)].sort();
    } else if (["from", "to"].includes(key)) out[key] = new Date(value).toISOString();
    else out[key] = key === "q" ? String(value).trim().toLowerCase() : value;
  }
  return stableValue(out);
}
