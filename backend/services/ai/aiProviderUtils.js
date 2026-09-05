import { sanitizeSensitiveData } from "../../utils/sanitize.js";
import { BlockList, isIP } from "node:net";

export const UNBOUNDED_QUOTA = Object.freeze({ getProviderSnapshot: () => ({ exhausted: false }) });

export class AiProviderError extends Error {
  constructor(code, message, options = {}) {
    super(message, { cause: options.cause });
    this.name = "AiProviderError";
    this.code = code;
    this.status = options.status || null;
    this.retryable = options.retryable === true;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.responseMetadata = options.responseMetadata ? structuredClone(options.responseMetadata) : null;
  }
}

const loopbackAddresses = new BlockList();
loopbackAddresses.addSubnet("127.0.0.0", 8, "ipv4");
loopbackAddresses.addAddress("::1", "ipv6");
const privateAddresses = new BlockList();
for (const [address, prefix] of [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["100.64.0.0", 10]]) {
  privateAddresses.addSubnet(address, prefix, "ipv4");
}
privateAddresses.addSubnet("fc00::", 7, "ipv6");

function unbracketHost(hostname) {
  return String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
}

export function isLoopbackHost(hostname = "") {
  const host = unbracketHost(hostname);
  return host === "localhost" || loopbackAddresses.check(host, isIP(host) === 6 ? "ipv6" : "ipv4");
}

export function parseBaseUrl(value, { label = "NVIDIA", allowPrivateHttp = false, apiKey = "", requireRemoteKey = false } = {}) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new AiProviderError("AI_BASE_URL_INVALID", `${label} base URL must be an absolute HTTP or HTTPS URL.`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new AiProviderError("AI_BASE_URL_INVALID", `${label} base URL must use HTTP or HTTPS without embedded credentials.`);
  }
  if (url.protocol !== "https:" && !isLoopbackHost(url.hostname)) {
    if (!allowPrivateHttp) throw new AiProviderError("AI_BASE_URL_INSECURE", `Remote ${label} base URL requires HTTPS or explicit private HTTP authorization.`);
    const host = unbracketHost(url.hostname);
    if (isIP(host) && !privateAddresses.check(host, isIP(host) === 6 ? "ipv6" : "ipv4")) {
      throw new AiProviderError("AI_PUBLIC_HTTP_FORBIDDEN", `${label} HTTP destination must be private.`);
    }
    // MagicDNS cannot be classified without DNS. The explicit flag authorizes
    // the operator's hostname; no DNS lookup or upstream call occurs at startup.
    if (!String(apiKey).trim()) throw new AiProviderError("AI_API_KEY_REQUIRED", `${label} API key is required for private HTTP.`);
  }
  if (requireRemoteKey && !isLoopbackHost(url.hostname) && !String(apiKey).trim()) {
    throw new AiProviderError("AI_API_KEY_REQUIRED", `${label} API key is required for a remote endpoint.`);
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

export function parseStructuredContent(content, responseMetadata = null, label = "NVIDIA") {
  if (content && typeof content === "object" && !Array.isArray(content)) return content;
  if (typeof content !== "string" || !content.trim()) {
    throw new AiProviderError("AI_EMPTY_RESPONSE", `${label} returned an empty completion.`, { responseMetadata });
  }
  try {
    const trimmed = content.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return JSON.parse(fenced ? fenced[1] : trimmed);
  } catch (error) {
    throw new AiProviderError("AI_INVALID_JSON", `${label} returned invalid structured JSON.`, { cause: error, responseMetadata });
  }
}

export function normalizeUsage(usage = {}) {
  const tokens = (value) => Number.isFinite(Number(value)) ? Math.max(0, Math.ceil(Number(value))) : 0;
  const promptTokens = tokens(usage?.prompt_tokens);
  const completionTokens = tokens(usage?.completion_tokens);
  const totalTokens = Math.max(tokens(usage?.total_tokens), promptTokens + completionTokens);
  return { promptTokens, completionTokens, totalTokens };
}

export function boundedText(value, maxLength = 240) {
  const normalized = String(value || "").trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

export function describeContent(content) {
  const contentType = content === null ? "null" : Array.isArray(content) ? "array" : typeof content;
  if (typeof content === "string" || Array.isArray(content)) {
    return { contentType, contentLength: content.length };
  }
  if (content && typeof content === "object") {
    try {
      return { contentType, contentLength: JSON.stringify(content).length };
    } catch {
      return { contentType, contentLength: 0 };
    }
  }
  return { contentType, contentLength: 0 };
}

export function resolveRequestId(response) {
  return boundedText(
    response?.headers?.get?.("x-request-id")
      || response?.headers?.get?.("nvcf-reqid")
      || response?.headers?.get?.("request-id")
  );
}

export function buildResponseMetadata({ payload = null, response = null, requestedModel, fallbackRequestId = null, pollCount = 0, includeErrorMessage = true }) {
  const choice = payload?.choices?.[0] || null;
  const message = choice?.message || null;
  const upstreamError = payload?.error && typeof payload.error === "object"
    ? {
        code: boundedText(payload.error.code || payload.error.type, 80),
        message: includeErrorMessage
          ? boundedText(sanitizeSensitiveData(String(payload.error.message || "NVIDIA returned an error response.")), 500)
          : "AI provider returned an error response."
      }
    : null;
  return {
    requestedModel: boundedText(requestedModel),
    payloadModel: boundedText(payload?.model),
    finishReason: boundedText(choice?.finish_reason, 80),
    requestId: resolveRequestId(response) || boundedText(payload?.requestId) || boundedText(fallbackRequestId),
    httpStatus: response?.status != null && Number.isFinite(Number(response.status)) ? Number(response.status) : null,
    pollCount: Math.max(0, Number(pollCount) || 0),
    upstreamError,
    usage: normalizeUsage(payload?.usage),
    ...describeContent(message?.content),
    hasReasoningContent: Boolean(
      message
      && Object.prototype.hasOwnProperty.call(message, "reasoning_content")
      && message.reasoning_content !== null
      && message.reasoning_content !== undefined
    )
  };
}

export function sanitizeProviderData(value, apiKey = "") {
  const redact = (item) => {
    if (typeof item === "string") return apiKey ? item.replaceAll(apiKey, "***") : item;
    if (Array.isArray(item)) return item.map(redact);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, redact(entry)]));
    return item;
  };
  return redact(sanitizeSensitiveData(value));
}
