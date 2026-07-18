const DEFAULT_MAX_FEEDS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function rssLabError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseFeedEntry(entry) {
  const raw = String(entry || "").trim();
  if (!raw) return null;

  const separator = raw.indexOf("|");
  const labelValue = separator >= 0 ? raw.slice(0, separator).trim() : "";
  const urlValue = separator >= 0 ? raw.slice(separator + 1).trim() : raw;

  let parsedUrl;
  try {
    parsedUrl = new URL(urlValue);
  } catch {
    throw rssLabError("RSS_LAB_INVALID_FEED_URL", "Every RSS lab feed must contain a valid absolute URL.");
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
    throw rssLabError(
      "RSS_LAB_UNSAFE_FEED_URL",
      "RSS lab feeds must use HTTP(S) and cannot contain URL credentials."
    );
  }

  const label = labelValue || parsedUrl.hostname;
  if (label.includes(",") || label.includes("|")) {
    throw rssLabError("RSS_LAB_INVALID_FEED_LABEL", "RSS lab feed labels cannot contain commas or pipes.");
  }

  parsedUrl.hash = "";
  return {
    label,
    url: parsedUrl.toString()
  };
}

export function parseRssLabFeeds(value, { maxFeeds = DEFAULT_MAX_FEEDS } = {}) {
  const entries = Array.isArray(value) ? value : String(value || "").split(",");
  const feeds = [];
  const seen = new Set();

  for (const entry of entries) {
    const feed = typeof entry === "object" && entry !== null
      ? parseFeedEntry(`${entry.label || ""}|${entry.url || ""}`)
      : parseFeedEntry(entry);
    if (!feed || seen.has(feed.url)) continue;
    seen.add(feed.url);
    feeds.push(feed);
  }

  if (!feeds.length) {
    throw rssLabError(
      "RSS_LAB_FEEDS_REQUIRED",
      "Set NEWS_RSS_FEEDS with one to five explicit feeds before starting the RSS lab."
    );
  }
  if (feeds.length > maxFeeds) {
    throw rssLabError(
      "RSS_LAB_TOO_MANY_FEEDS",
      `The RSS lab accepts at most ${maxFeeds} feeds per run; split larger comparisons into batches.`
    );
  }

  return feeds;
}

export function serializeRssLabFeeds(feeds = []) {
  return feeds.map((feed) => `${feed.label}|${feed.url}`).join(",");
}

function requestUrl(input) {
  if (input instanceof URL) return new URL(input.toString());
  if (typeof Request !== "undefined" && input instanceof Request) return new URL(input.url);
  return new URL(String(input));
}

function isLoopback(hostname = "") {
  const normalized = String(hostname).toLowerCase();
  return normalized === "localhost" || normalized === "::1" || normalized === "[::1]" || /^127\./.test(normalized);
}

async function discardResponse(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // The response is being discarded only to enforce the redirect boundary.
  }
}

export function createRssLabFetchGuard({ feeds, fetchImpl = globalThis.fetch, maxRedirects = 4 } = {}) {
  if (typeof fetchImpl !== "function") {
    throw rssLabError("RSS_LAB_FETCH_UNAVAILABLE", "A fetch implementation is required for the RSS lab.");
  }

  const parsedFeeds = parseRssLabFeeds(feeds);
  const allowedHosts = new Set(parsedFeeds.map((feed) => new URL(feed.url).hostname.toLowerCase()));

  return async function guardedRssLabFetch(input, options = {}) {
    let target = requestUrl(input);
    let method = String(options.method || (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET")).toUpperCase();
    let body = options.body;

    if (!["GET", "HEAD"].includes(method) && !isLoopback(target.hostname)) {
      throw rssLabError("RSS_LAB_METHOD_BLOCKED", `RSS lab blocked outbound ${method}.`);
    }

    for (let redirectCount = 0; ; redirectCount += 1) {
      const hostname = target.hostname.toLowerCase();
      if (!isLoopback(hostname) && !allowedHosts.has(hostname)) {
        throw rssLabError("RSS_LAB_OUTBOUND_BLOCKED", `RSS lab blocked outbound host: ${hostname}`);
      }

      const response = await fetchImpl(target, {
        ...options,
        method,
        body,
        redirect: "manual"
      });
      if (!REDIRECT_STATUSES.has(response.status) || !response.headers.get("location")) return response;

      if (redirectCount >= maxRedirects) {
        await discardResponse(response);
        throw rssLabError("RSS_LAB_REDIRECT_LIMIT", "RSS lab feed exceeded the redirect limit.");
      }

      const nextTarget = new URL(response.headers.get("location"), target);
      const nextHostname = nextTarget.hostname.toLowerCase();
      if (!isLoopback(nextHostname) && !allowedHosts.has(nextHostname)) {
        await discardResponse(response);
        throw rssLabError(
          "RSS_LAB_REDIRECT_HOST_BLOCKED",
          `RSS lab blocked redirect host: ${nextHostname}`
        );
      }

      await discardResponse(response);
      target = nextTarget;
      if (response.status === 303 && method !== "HEAD") {
        method = "GET";
        body = undefined;
      }
    }
  };
}

export const RSS_LAB_MAX_FEEDS = DEFAULT_MAX_FEEDS;
