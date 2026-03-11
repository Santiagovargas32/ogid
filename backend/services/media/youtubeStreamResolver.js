function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textFromRuns(value = {}) {
  if (Array.isArray(value?.runs)) {
    return value.runs.map((run) => String(run?.text || "")).join("");
  }
  return String(value?.simpleText || "");
}

function isLiveBadge(node = {}) {
  const style = String(node?.metadataBadgeRenderer?.style || "").toUpperCase();
  if (style.includes("LIVE")) {
    return true;
  }
  const label = String(node?.metadataBadgeRenderer?.label || "").toUpperCase();
  return label.includes("LIVE");
}

function isLiveOverlay(node = {}) {
  const renderer = node?.thumbnailOverlayTimeStatusRenderer;
  if (!renderer) {
    return false;
  }
  const style = String(renderer.style || "").toUpperCase();
  if (style.includes("LIVE")) {
    return true;
  }
  const text = textFromRuns(renderer.text || {}).toUpperCase();
  return text.includes("LIVE");
}

function isLiveRenderer(renderer = {}) {
  if (!renderer || !renderer.videoId) {
    return false;
  }

  const badges = []
    .concat(renderer.badges || [])
    .concat(renderer.ownerBadges || []);
  if (badges.some((badge) => isLiveBadge(badge))) {
    return true;
  }

  const overlays = Array.isArray(renderer.thumbnailOverlays) ? renderer.thumbnailOverlays : [];
  if (overlays.some((overlay) => isLiveOverlay(overlay))) {
    return true;
  }

  const thumbnailStatus = textFromRuns(renderer.badgeText || {}).toUpperCase();
  if (thumbnailStatus.includes("LIVE")) {
    return true;
  }

  return false;
}

function findLiveVideoIdInObject(root = null) {
  if (!root) {
    return null;
  }

  const queue = [root];
  const visited = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== "object") {
      continue;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    if (isObject(current) && typeof current.videoId === "string" && isLiveRenderer(current)) {
      return current.videoId;
    }

    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }

  return null;
}

function extractBalancedJsonObject(source = "", objectStartIndex = -1) {
  if (objectStartIndex < 0 || objectStartIndex >= source.length || source[objectStartIndex] !== "{") {
    return null;
  }

  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let index = objectStartIndex; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(objectStartIndex, index + 1);
      }
      continue;
    }
  }

  return null;
}

function extractJsonAfterAnchor(source = "", anchor = "") {
  const anchorIndex = source.indexOf(anchor);
  if (anchorIndex < 0) {
    return null;
  }

  const objectStart = source.indexOf("{", anchorIndex + anchor.length);
  if (objectStart < 0) {
    return null;
  }

  return extractBalancedJsonObject(source, objectStart);
}

function parseLiveVideoIdFromRegex(source = "") {
  const liveStyleMatch = source.match(/"videoId":"([a-zA-Z0-9_-]{11})"[\s\S]{0,1600}"style":"[^"]*LIVE/i);
  if (liveStyleMatch?.[1]) {
    return liveStyleMatch[1];
  }

  const liveLabelMatch = source.match(/"videoId":"([a-zA-Z0-9_-]{11})"[\s\S]{0,1600}"label":"[^"]*LIVE/i);
  if (liveLabelMatch?.[1]) {
    return liveLabelMatch[1];
  }

  return null;
}

export function parseYoutubeLiveVideoIdFromHtml(html = "") {
  const source = String(html || "");
  const anchors = [
    "var ytInitialData =",
    "window['ytInitialData'] =",
    'window["ytInitialData"] =',
    "ytInitialData ="
  ];

  for (const anchor of anchors) {
    const payload = extractJsonAfterAnchor(source, anchor);
    if (!payload) {
      continue;
    }
    try {
      const parsed = JSON.parse(payload);
      const videoId = findLiveVideoIdInObject(parsed);
      if (videoId) {
        return videoId;
      }
    } catch {
      // Ignore parse errors and continue with other anchor strategies.
    }
  }

  return parseLiveVideoIdFromRegex(source);
}

function toStreamsUrl(item = {}) {
  if (item?.channelHandle) {
    const handle = String(item.channelHandle).replace(/^@/, "");
    return `https://www.youtube.com/@${handle}/streams`;
  }
  if (item?.channelId) {
    return `https://www.youtube.com/channel/${String(item.channelId)}/streams`;
  }
  return String(item?.fallbackUrl || "");
}

export async function resolveYoutubeLiveStream({
  item = {},
  timeoutMs = 8_000,
  fetchImpl = fetch
} = {}) {
  const streamsUrl = toStreamsUrl(item);
  if (!streamsUrl) {
    return {
      status: "error",
      error: "missing-youtube-streams-url",
      streamsUrl: null
    };
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs || 8_000)));

  try {
    const response = await fetchImpl(streamsUrl, {
      method: "GET",
      redirect: "follow",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      return {
        status: "error",
        error: `youtube-upstream-${response.status}`,
        streamsUrl
      };
    }

    const html = await response.text();
    const videoId = parseYoutubeLiveVideoIdFromHtml(html);
    if (!videoId) {
      return {
        status: "offline",
        videoId: null,
        streamsUrl
      };
    }

    return {
      status: "live",
      videoId,
      embedUrl: `https://www.youtube.com/embed/${videoId}`,
      watchUrl: `https://www.youtube.com/watch?v=${videoId}`,
      streamsUrl
    };
  } catch (error) {
    const code = error?.name === "AbortError" ? "youtube-timeout" : "youtube-request-failed";
    return {
      status: "error",
      error: code,
      message: error?.message || code,
      streamsUrl
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

