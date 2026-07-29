import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { AWARENESS_SOURCES } from "../services/awareness/awarenessCatalog.js";
import { parseAwarenessSource } from "../services/awareness/awarenessParsers.js";
import { normalizeAwarenessUserAgent, resolveSourceRequestUrl } from "../services/awareness/awarenessService.js";
import { sanitizeSensitiveData } from "../utils/sanitize.js";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TIMEOUT_MS = 9_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
const MAX_SOURCES = 10;
const MAX_REDIRECTS = 2;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const OUTPUT_PREFIX_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const LAB_USER_AGENT = "OGID-awareness-admission-lab/1.0 (+https://localhost; contact: local-operator)";
const RELEVANT_RESPONSE_HEADERS = Object.freeze([
  "content-type",
  "etag",
  "last-modified",
  "retry-after",
  "server",
  "via",
  "cf-ray",
  "x-request-id",
  "x-amz-request-id",
  "x-amz-cf-id",
  "x-amzn-requestid",
  "x-correlation-id",
  "akamai-grn",
  "x-akamai-request-id"
]);

function labError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function boundedInteger(value, fallback, { min, max }) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function safeHeaderValue(value) {
  const normalized = String(value || "")
    .replace(/[\r\n\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, 256) : null;
}

function sourceAdmissionState(source = {}) {
  const explicit = String(source.admissionState || "").trim().toLowerCase();
  if (["probing", "shadow", "active", "blocked"].includes(explicit)) return explicit;
  if (source.enabled !== false) return "active";
  return /pending|probe|promotion/i.test(String(source.disabledReason || "")) ? "probing" : "blocked";
}

function validateSourceId(value) {
  const sourceId = String(value || "").trim();
  if (!SOURCE_ID_PATTERN.test(sourceId)) {
    throw labError("AWARENESS_LAB_INVALID_SOURCE_ID", "Awareness source IDs may contain only letters, numbers, dots, underscores and hyphens.");
  }
  return sourceId;
}

export function selectAwarenessLabSources({ sourceIds = [], allProbing = false, catalog = AWARENESS_SOURCES, runtimeBlockedSourceIds = new Set() } = {}) {
  if (allProbing && sourceIds.length) {
    throw labError("AWARENESS_LAB_SELECTION_CONFLICT", "Use explicit source IDs or --all-probing, not both.");
  }
  const requested = [...new Set(sourceIds.map(validateSourceId))];
  let selected;
  if (allProbing) {
    selected = catalog.filter((source) => sourceAdmissionState(source) === "probing");
  } else {
    if (!requested.length) {
      throw labError("AWARENESS_LAB_SOURCES_REQUIRED", "Select between one and ten awareness source IDs.");
    }
    const sourceById = new Map(catalog.map((source) => [source.sourceId, source]));
    const missing = requested.filter((sourceId) => !sourceById.has(sourceId));
    if (missing.length) {
      throw labError("AWARENESS_LAB_SOURCE_NOT_FOUND", `Unknown awareness source ID: ${missing.join(",")}`);
    }
    selected = requested.map((sourceId) => sourceById.get(sourceId));
    const blocked = selected.filter((source) => sourceAdmissionState(source) === "blocked");
    if (blocked.length) {
      throw labError(
        "AWARENESS_LAB_SOURCE_BLOCKED",
        `Blocked awareness sources cannot be probed: ${blocked.map((source) => source.sourceId).join(",")}. Move a reviewed replacement to probing instead.`
      );
    }
  }
  if (!selected.length) {
    throw labError("AWARENESS_LAB_NO_PROBING_SOURCES", "The catalog has no sources in probing state.");
  }
  if (selected.length > MAX_SOURCES) {
    throw labError("AWARENESS_LAB_TOO_MANY_SOURCES", `The awareness admission lab accepts at most ${MAX_SOURCES} sources per run.`);
  }
  const runtimeBlocked = selected.filter((source) => runtimeBlockedSourceIds.has(source.sourceId));
  if (runtimeBlocked.length) {
    throw labError(
      "AWARENESS_LAB_SOURCE_RUNTIME_BLOCKED",
      `Runtime-blocked awareness sources cannot be probed: ${runtimeBlocked.map((source) => source.sourceId).join(",")}. Register a reviewed replacement under a new source ID.`
    );
  }
  return selected;
}

async function resolveRuntimeSnapshotPath({ env = process.env, envFilePath = path.resolve(backendDir, ".env") } = {}) {
  const explicit = String(env.AWARENESS_STATE_FILE || "").trim();
  if (explicit) return path.resolve(backendDir, explicit);
  try {
    const parsed = dotenv.parse(await readFile(envFilePath, "utf8"));
    const configured = String(parsed.AWARENESS_STATE_FILE || "").trim();
    return path.resolve(backendDir, configured || "data/intel/awareness-events.json");
  } catch (error) {
    if (error?.code === "ENOENT") return path.resolve(backendDir, "data/intel/awareness-events.json");
    throw labError("AWARENESS_LAB_RUNTIME_CONFIG_INVALID", "The awareness runtime state configuration could not be read safely.");
  }
}

export async function resolveAwarenessLabUserAgent({ env = process.env, envFilePath = path.resolve(backendDir, ".env") } = {}) {
  const explicit = String(env.AWARENESS_USER_AGENT || "").trim();
  if (explicit) return normalizeAwarenessUserAgent(explicit);
  try {
    const parsed = dotenv.parse(await readFile(envFilePath, "utf8"));
    return normalizeAwarenessUserAgent(parsed.AWARENESS_USER_AGENT || LAB_USER_AGENT);
  } catch (error) {
    if (error?.code === "ENOENT") return normalizeAwarenessUserAgent(LAB_USER_AGENT);
    throw labError("AWARENESS_LAB_RUNTIME_CONFIG_INVALID", "The awareness runtime user-agent configuration could not be read safely.");
  }
}

export async function readRuntimeBlockedSourceIds({ snapshotPath = null, env = process.env, envFilePath } = {}) {
  try {
    const resolvedSnapshotPath = snapshotPath
      ? path.resolve(snapshotPath)
      : await resolveRuntimeSnapshotPath({ env, envFilePath });
    const payload = JSON.parse(await readFile(resolvedSnapshotPath, "utf8"));
    if (payload?.schemaVersion !== "awareness-v1" || !Array.isArray(payload.sourceStatus)) {
      throw labError("AWARENESS_LAB_RUNTIME_STATE_INVALID", "The awareness runtime state has an unsupported structure.");
    }
    return new Set(payload.sourceStatus.filter((status) =>
      status?.runtimeBlocked === true ||
      (status?.admissionState === "blocked" && status?.blockedReason === "persistent-http-403")
    ).map((status) => String(status.sourceId || "")).filter(Boolean));
  } catch (error) {
    if (error?.code === "ENOENT") return new Set();
    if (error?.code === "AWARENESS_LAB_RUNTIME_STATE_INVALID") throw error;
    throw labError("AWARENESS_LAB_RUNTIME_STATE_INVALID", "The awareness runtime state could not be read safely.");
  }
}

export function parseAwarenessLabCliArgs(args = []) {
  const options = {
    sourceIds: [],
    allProbing: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
    outputDir: path.resolve(backendDir, "reports"),
    outputPrefix: "awareness-admission-lab-latest"
  };
  for (const argument of args) {
    const [name, ...valueParts] = String(argument || "").split("=");
    const value = valueParts.join("=");
    if (name === "--source") options.sourceIds.push(validateSourceId(value));
    else if (name === "--sources") options.sourceIds.push(...value.split(",").filter(Boolean).map(validateSourceId));
    else if (name === "--all-probing" && !value) options.allProbing = true;
    else if (name === "--timeout-ms") options.timeoutMs = boundedInteger(value, Number.NaN, { min: 500, max: 30_000 });
    else if (name === "--max-bytes") options.maxResponseBytes = boundedInteger(value, Number.NaN, { min: 1_024, max: DEFAULT_MAX_RESPONSE_BYTES });
    else if (name === "--output-prefix") options.outputPrefix = value;
    else throw labError("AWARENESS_LAB_UNKNOWN_ARGUMENT", `Unknown awareness lab argument: ${name}`);
  }
  options.sourceIds = [...new Set(options.sourceIds)];
  if (!Number.isFinite(options.timeoutMs)) throw labError("AWARENESS_LAB_INVALID_TIMEOUT", "The awareness lab timeout is outside the supported range.");
  if (!Number.isFinite(options.maxResponseBytes)) throw labError("AWARENESS_LAB_INVALID_MAX_BYTES", "The awareness lab response limit is outside the supported range.");
  if (!OUTPUT_PREFIX_PATTERN.test(options.outputPrefix)) throw labError("AWARENESS_LAB_INVALID_OUTPUT_PREFIX", "The awareness lab output prefix is invalid.");
  return options;
}

function acceptHeaderFor(source) {
  if (source.adapter === "ics") return "text/calendar,text/plain;q=0.9,*/*;q=0.1";
  if (source.adapter === "rss") return "application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.1";
  if (String(source.adapter || "").endsWith("json")) return "application/json";
  return "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5";
}

function allowedContentType(source, value = "") {
  const type = String(value || "").toLowerCase().split(";")[0].trim();
  if (!type) return false;
  if (source.adapter === "ics") return ["text/calendar", "text/plain", "application/octet-stream"].includes(type);
  if (source.adapter === "rss") return type.includes("xml") || ["application/rss+xml", "application/atom+xml", "text/plain"].includes(type);
  if (String(source.adapter || "").endsWith("json")) return type.includes("json");
  return type.includes("html") || type === "text/plain";
}

function sanitizedResponseHeaders(headers) {
  return Object.fromEntries(RELEVANT_RESPONSE_HEADERS.flatMap((name) => {
    const value = safeHeaderValue(headers?.get?.(name));
    return value ? [[name, value]] : [];
  }));
}

function validateRequestUrl(value, allowedHosts) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw labError("AWARENESS_LAB_INVALID_URL", "The selected awareness source URL is invalid.");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw labError("AWARENESS_LAB_UNSAFE_URL", "Awareness admission probes require credential-free HTTPS URLs.");
  }
  if (!allowedHosts.has(url.hostname.toLowerCase())) {
    throw labError("AWARENESS_LAB_HOST_BLOCKED", "The awareness admission lab blocked an undeclared host.");
  }
  return url;
}

async function discardResponse(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // The response is intentionally discarded to preserve the redirect boundary.
  }
}

async function readLimitedBody(response, maxBytes) {
  const declaredBytes = Number(response.headers?.get?.("content-length") || 0);
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    await discardResponse(response);
    throw labError("AWARENESS_LAB_RESPONSE_TOO_LARGE", "The awareness source response exceeded the admission lab limit.");
  }
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw labError("AWARENESS_LAB_RESPONSE_TOO_LARGE", "The awareness source response exceeded the admission lab limit.");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw labError("AWARENESS_LAB_RESPONSE_TOO_LARGE", "The awareness source response exceeded the admission lab limit.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

async function fetchSourceOnce(source, {
  fetchImpl,
  timeoutMs,
  maxResponseBytes,
  nowMs,
  userAgent
}) {
  if (typeof fetchImpl !== "function") throw labError("AWARENESS_LAB_FETCH_UNAVAILABLE", "A fetch implementation is required.");
  let catalogUrl;
  try {
    catalogUrl = new URL(source.url);
  } catch {
    throw labError("AWARENESS_LAB_INVALID_URL", "The selected awareness source URL is invalid.");
  }
  const declaredHosts = [source.hostname, catalogUrl.hostname, ...(source.redirectHosts || [])]
    .filter(Boolean)
    .map((hostname) => String(hostname).toLowerCase());
  const allowedHosts = new Set(declaredHosts);
  let target = validateRequestUrl(resolveSourceRequestUrl(source, nowMs), allowedHosts);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let networkRequests = 0;
  try {
    for (let redirectCount = 0; ; redirectCount += 1) {
      networkRequests += 1;
      const response = await fetchImpl(target, {
        method: "GET",
        headers: {
          Accept: acceptHeaderFor(source),
          "User-Agent": normalizeAwarenessUserAgent(userAgent || LAB_USER_AGENT)
        },
        redirect: "manual",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: controller.signal
      });
      const location = response.headers?.get?.("location");
      if (!REDIRECT_STATUSES.has(response.status) || !location) {
        const body = await readLimitedBody(response, maxResponseBytes);
        return { response, body, redirectCount, networkRequests };
      }
      if (redirectCount >= MAX_REDIRECTS) {
        await discardResponse(response);
        throw labError("AWARENESS_LAB_REDIRECT_LIMIT", "The awareness source exceeded the admission lab redirect limit.");
      }
      const redirected = validateRequestUrl(new URL(location, target).toString(), allowedHosts);
      await discardResponse(response);
      target = redirected;
    }
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") {
      const timeoutError = labError("AWARENESS_LAB_TIMEOUT", "The awareness source probe timed out.");
      timeoutError.networkRequests = networkRequests;
      throw timeoutError;
    }
    error.networkRequests = networkRequests;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function countBy(values = []) {
  const counts = new Map();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) || 0) + 1);
  return Object.fromEntries([...counts.entries()].sort((left, right) => left[0].localeCompare(right[0])));
}

function eventQuality(events = []) {
  const validTimes = events.flatMap((event) => [event.scheduledAt, event.publishedAt, event.updatedAt])
    .filter((value) => Number.isFinite(Date.parse(value)));
  return {
    parsedEvents: events.length,
    kinds: countBy(events.map((event) => event.kind)),
    statuses: countBy(events.map((event) => event.status)),
    locationPrecision: countBy(events.map((event) => event.location?.precision || "none")),
    eventsWithCanonicalUrl: events.filter((event) => {
      try { return new URL(event.canonicalUrl).protocol === "https:"; } catch { return false; }
    }).length,
    eventsWithScheduledAt: events.filter((event) => Number.isFinite(Date.parse(event.scheduledAt))).length,
    eventsWithPublishedAt: events.filter((event) => Number.isFinite(Date.parse(event.publishedAt))).length,
    earliestObservedEventAt: validTimes.length ? new Date(Math.min(...validTimes.map(Date.parse))).toISOString() : null,
    latestObservedEventAt: validTimes.length ? new Date(Math.max(...validTimes.map(Date.parse))).toISOString() : null
  };
}

function classifyProbe({ httpStatus = null, contentTypeAllowed = false, parsedEvents = 0, emptyResultAllowed = false, errorCode = null } = {}) {
  if ([401, 403, 451].includes(httpStatus)) return "blocked-by-upstream";
  if (httpStatus === 429) return "rate-limited";
  if (httpStatus !== null && httpStatus >= 500) return "transient-upstream-failure";
  if (errorCode === "AWARENESS_LAB_TIMEOUT") return "transient-timeout";
  if (errorCode === "AWARENESS_LAB_RESPONSE_TOO_LARGE") return "rejected-size-limit";
  if (errorCode === "AWARENESS_LAB_PARSER_FAILED") return "rejected-structure";
  if (errorCode) return "probe-failed";
  if (httpStatus === null || httpStatus < 200 || httpStatus >= 300) return "upstream-failure";
  if (!contentTypeAllowed) return "rejected-content-type";
  if (!parsedEvents && !emptyResultAllowed) return "reachable-empty";
  return "candidate-for-shadow";
}

function recommendationFor(probeResult) {
  if (probeResult === "candidate-for-shadow") {
    return {
      maximumState: "shadow",
      automaticPromotion: false,
      manualReviewRequired: true,
      requirements: ["stable-structure", "verified-attribution", "correct-times", "no-false-coordinates", "seven-day-success-gate"]
    };
  }
  return {
    maximumState: null,
    automaticPromotion: false,
    manualReviewRequired: true,
    requirements: ["resolve-probe-result-before-shadow"]
  };
}

function safeProbeFailureCode(error) {
  const code = String(error?.code || "");
  if (/^AWARENESS_LAB_[A-Z0-9_]+$/.test(code)) return code;
  return "AWARENESS_LAB_REQUEST_FAILED";
}

export async function probeAwarenessSource(source, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  nowMs = Date.now(),
  userAgent = LAB_USER_AGENT
} = {}) {
  const startedAt = Date.now();
  const base = {
    sourceId: source.sourceId,
    name: source.name,
    hostname: new URL(source.url).hostname.toLowerCase(),
    adapter: source.adapter,
    catalogAdmissionState: sourceAdmissionState(source),
    logicalAttempts: 1,
    retries: 0
  };
  try {
    const { response, body, redirectCount, networkRequests } = await fetchSourceOnce(source, {
      fetchImpl,
      timeoutMs,
      maxResponseBytes,
      nowMs,
      userAgent
    });
    const responseHeaders = sanitizedResponseHeaders(response.headers);
    const contentTypeAllowed = allowedContentType(source, responseHeaders["content-type"]);
    const bodySha256 = createHash("sha256").update(body).digest("hex");
    let events = [];
    let parserError = false;
    if (response.ok && contentTypeAllowed) {
      try {
        events = parseAwarenessSource(body.toString("utf8"), source, { observedAt: new Date(nowMs).toISOString() });
      } catch {
        parserError = true;
      }
    }
    const errorCode = parserError ? "AWARENESS_LAB_PARSER_FAILED" : null;
    const probeResult = classifyProbe({
      httpStatus: response.status,
      contentTypeAllowed,
      parsedEvents: events.length,
      emptyResultAllowed: source.emptyResultPolicy === "healthy",
      errorCode
    });
    return {
      ...base,
      probeResult,
      recommendation: recommendationFor(probeResult),
      httpStatus: response.status,
      contentTypeAllowed,
      responseHeaders,
      responseRequestId: responseHeaders["x-request-id"]
        || responseHeaders["x-amz-request-id"]
        || responseHeaders["x-amz-cf-id"]
        || responseHeaders["x-amzn-requestid"]
        || responseHeaders["x-correlation-id"]
        || responseHeaders["akamai-grn"]
        || responseHeaders["x-akamai-request-id"]
        || responseHeaders["cf-ray"]
        || null,
      bodyBytes: body.byteLength,
      bodySha256,
      redirectCount,
      networkRequests,
      latencyMs: Math.max(0, Date.now() - startedAt),
      errorCode: response.ok ? errorCode : `AWARENESS_UPSTREAM_${response.status}`,
      quality: eventQuality(events)
    };
  } catch (error) {
    const errorCode = safeProbeFailureCode(error);
    const probeResult = classifyProbe({ errorCode });
    return {
      ...base,
      probeResult,
      recommendation: recommendationFor(probeResult),
      httpStatus: null,
      contentTypeAllowed: false,
      responseHeaders: {},
      responseRequestId: null,
      bodyBytes: null,
      bodySha256: null,
      redirectCount: 0,
      networkRequests: Number.isFinite(Number(error?.networkRequests))
        ? Number(error.networkRequests)
        : ["AWARENESS_LAB_FETCH_UNAVAILABLE", "AWARENESS_LAB_INVALID_URL", "AWARENESS_LAB_UNSAFE_URL", "AWARENESS_LAB_HOST_BLOCKED"].includes(errorCode) ? 0 : 1,
      latencyMs: Math.max(0, Date.now() - startedAt),
      errorCode,
      quality: eventQuality([])
    };
  }
}

export function summarizeAwarenessLab(results = []) {
  return {
    selectedSources: results.length,
    logicalAttempts: results.reduce((total, result) => total + Number(result.logicalAttempts || 0), 0),
    networkRequests: results.reduce((total, result) => total + Number(result.networkRequests || 0), 0),
    parsedEvents: results.reduce((total, result) => total + Number(result.quality?.parsedEvents || 0), 0),
    probeResults: countBy(results.map((result) => result.probeResult)),
    candidatesForShadow: results.filter((result) => result.probeResult === "candidate-for-shadow").length,
    automaticPromotions: 0
  };
}

export async function runAwarenessAdmissionLab({
  sources,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  nowMs = Date.now(),
  userAgent = LAB_USER_AGENT,
  onProgress = null
} = {}) {
  if (!Array.isArray(sources) || !sources.length || sources.length > MAX_SOURCES) {
    throw labError("AWARENESS_LAB_INVALID_SOURCE_BATCH", `The awareness admission lab requires between one and ${MAX_SOURCES} sources.`);
  }
  const results = [];
  for (let index = 0; index < sources.length; index += 1) {
    const result = await probeAwarenessSource(sources[index], { fetchImpl, timeoutMs, maxResponseBytes, nowMs, userAgent });
    results.push(result);
    onProgress?.({ index: index + 1, total: sources.length, result });
  }
  return {
    schemaVersion: 1,
    mode: "awareness-admission-lab",
    generatedAt: new Date(nowMs).toISOString(),
    requestPolicy: {
      sourceCount: sources.length,
      maximumSources: MAX_SOURCES,
      concurrency: 1,
      retries: 0,
      timeoutMs,
      maxResponseBytes,
      maxRedirects: MAX_REDIRECTS,
      httpsOnly: true,
      redirectAllowlist: "selected-source-hosts",
      backgroundRefresh: false,
      persistence: false,
      runtimeBlockStateReadOnly: true,
      publication: false,
      credentials: false,
      userAgentPolicy: "same-as-runtime-sanitized"
    },
    summary: summarizeAwarenessLab(results),
    sources: results
  };
}

function markdownCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderAwarenessLabMarkdown(report) {
  const rows = report.sources.map((source) => [
    source.sourceId,
    source.catalogAdmissionState,
    source.probeResult,
    source.httpStatus ?? "-",
    source.quality?.parsedEvents || 0,
    source.responseHeaders?.["content-type"] || "-",
    source.latencyMs,
    source.bodySha256 || "-"
  ]);
  return [
    "# Awareness Admission Lab",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "This isolated probe performs one logical attempt per selected source, with no retries, persistence or publication. Payload bodies and cookies are never included.",
    "",
    "A `candidate-for-shadow` result requires manual review and the seven-day gate; this lab never promotes a source to `active`.",
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| Selected sources | ${report.summary.selectedSources} |`,
    `| Logical attempts | ${report.summary.logicalAttempts} |`,
    `| Parsed events | ${report.summary.parsedEvents} |`,
    `| Candidates for shadow | ${report.summary.candidatesForShadow} |`,
    `| Automatic promotions | ${report.summary.automaticPromotions} |`,
    "",
    "## Results",
    "",
    "| Source | Catalog state | Probe result | HTTP | Events | Content type | Latency ms | Body SHA-256 |",
    "|---|---|---|---:|---:|---|---:|---|",
    ...rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`),
    ""
  ].join("\n");
}

export async function writeAwarenessLabReports(report, {
  outputDir = path.resolve(backendDir, "reports"),
  outputPrefix = "awareness-admission-lab-latest"
} = {}) {
  if (!OUTPUT_PREFIX_PATTERN.test(outputPrefix)) throw labError("AWARENESS_LAB_INVALID_OUTPUT_PREFIX", "The awareness lab output prefix is invalid.");
  const sanitized = sanitizeSensitiveData(report);
  await mkdir(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, `${outputPrefix}.json`);
  const markdownPath = path.join(outputDir, `${outputPrefix}.md`);
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8"),
    writeFile(markdownPath, `${renderAwarenessLabMarkdown(sanitized)}\n`, "utf8")
  ]);
  return { jsonPath, markdownPath };
}

async function main() {
  try {
    const options = parseAwarenessLabCliArgs(process.argv.slice(2));
    const runtimeBlockedSourceIds = await readRuntimeBlockedSourceIds();
    const userAgent = await resolveAwarenessLabUserAgent();
    const sources = selectAwarenessLabSources({ ...options, runtimeBlockedSourceIds });
    const report = await runAwarenessAdmissionLab({
      sources,
      timeoutMs: options.timeoutMs,
      maxResponseBytes: options.maxResponseBytes,
      userAgent,
      onProgress: ({ index, total, result }) => {
        process.stderr.write(`[${index}/${total}] ${result.sourceId} ${result.probeResult} http=${result.httpStatus ?? "-"} events=${result.quality.parsedEvents}\n`);
      }
    });
    const outputs = await writeAwarenessLabReports(report, options);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      generatedAt: report.generatedAt,
      requestPolicy: report.requestPolicy,
      summary: report.summary,
      outputs
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(sanitizeSensitiveData({
      ok: false,
      error: {
        code: /^AWARENESS_LAB_[A-Z0-9_]+$/.test(String(error?.code || "")) ? error.code : "AWARENESS_LAB_FAILED",
        message: error?.message || "Awareness admission lab failed."
      }
    }), null, 2)}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();

export {
  DEFAULT_MAX_RESPONSE_BYTES as AWARENESS_LAB_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS as AWARENESS_LAB_DEFAULT_TIMEOUT_MS,
  MAX_SOURCES as AWARENESS_LAB_MAX_SOURCES
};
