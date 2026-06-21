import { buildStreamPlaybackSignature, resolveVideoStreamSelection } from "./mediaPlaybackPolicy.js";

const VIDEO_STREAMS = [
  {
    id: "bloomberg",
    name: "Bloomberg",
    region: "Global",
    mode: "embed",
    embedUrl: "https://www.youtube.com/embed/live_stream?channel=UCIALMKvObZNtJ6AmdCLP7Lg",
    channelId: "UCIALMKvObZNtJ6AmdCLP7Lg",
    handle: "@markets",
    fallbackUrl: "https://www.youtube.com/@markets/streams",
    availability: "channel_fallback"
  },
  {
    id: "reuters",
    name: "Reuters",
    region: "Global",
    mode: "embed",
    embedUrl: "https://www.youtube.com/embed/live_stream?channel=UChqUTb7kYRX8-EiaN3XFrSQ",
    channelId: "UChqUTb7kYRX8-EiaN3XFrSQ",
    handle: "@Reuters",
    fallbackUrl: "https://www.youtube.com/@Reuters/streams",
    availability: "channel_fallback"
  },
  {
    id: "bbc-news",
    name: "BBC News",
    region: "Global",
    mode: "link",
    fallbackUrl: "https://www.youtube.com/@BBCNews/streams",
    availability: "unverified"
  },
  {
    id: "sky-news",
    name: "Sky News",
    region: "Europe",
    mode: "embed",
    embedUrl: "https://www.youtube.com/embed/live_stream?channel=UCoMdktPbSTixAyNGwb-UYkQ",
    fallbackUrl: "https://www.youtube.com/@SkyNews/streams",
    availability: "unverified"
  },
  {
    id: "france24",
    name: "France 24",
    region: "Europe",
    mode: "embed",
    embedUrl: "https://www.youtube.com/embed/live_stream?channel=UCE9-RvWlHixPLyGQk9TRj3Q",
    fallbackUrl: "https://www.youtube.com/@FRANCE24/streams",
    availability: "unverified"
  },
  {
    id: "dw",
    name: "DW News",
    region: "Europe",
    mode: "embed",
    embedUrl: "https://www.youtube.com/embed/live_stream?channel=UCknLrEdhRCp1aegoMqRaCZg",
    fallbackUrl: "https://www.youtube.com/@dwnews/streams",
    availability: "unverified"
  },
  {
    id: "al-jazeera",
    name: "Al Jazeera English",
    region: "MENA",
    mode: "embed",
    embedUrl: "https://www.youtube.com/embed/live_stream?channel=UCR0DUmNzPhLyX6wnmvvEgKA",
    fallbackUrl: "https://www.youtube.com/@aljazeeraenglish/streams",
    availability: "unverified"
  },
  {
    id: "i24",
    name: "i24NEWS",
    region: "MENA",
    mode: "link",
    fallbackUrl: "https://www.youtube.com/@i24NEWS/streams",
    availability: "unverified"
  },
  {
    id: "abc-news",
    name: "ABC News",
    region: "Americas",
    mode: "embed",
    embedUrl: "https://www.youtube.com/embed/live_stream?channel=UCBi2mrWuNuyYy4gbM6fU18Q",
    fallbackUrl: "https://www.youtube.com/@ABCNews/streams",
    availability: "unverified"
  },
  {
    id: "cbs-news",
    name: "CBS News",
    region: "Americas",
    mode: "embed",
    embedUrl: "https://www.youtube.com/embed/live_stream?channel=UC8p1vwvWtl6T73JiExfWs1g",
    fallbackUrl: "https://www.youtube.com/@CBSNews/streams",
    availability: "unverified"
  },
  {
    id: "nbc-news",
    name: "NBC News",
    region: "Americas",
    mode: "embed",
    embedUrl: "https://www.youtube.com/embed/live_stream?channel=UCeY0bbntWzzVIaj2z3QigXg",
    fallbackUrl: "https://www.youtube.com/@NBCNews/streams",
    availability: "unverified"
  },
  {
    id: "cbc-news",
    name: "CBC News",
    region: "Americas",
    mode: "link",
    fallbackUrl: "https://www.youtube.com/@CBCNews/streams",
    availability: "unverified"
  },
  {
    id: "euronews",
    name: "Euronews",
    region: "Europe",
    mode: "embed",
    embedUrl: "https://www.youtube.com/embed/live_stream?channel=UCSrZ3UV4jOidv8ppoVuvW9Q",
    fallbackUrl: "https://www.youtube.com/@euronews/streams",
    availability: "unverified"
  },
  {
    id: "ndtv",
    name: "NDTV",
    region: "Asia",
    mode: "link",
    fallbackUrl: "https://www.youtube.com/@NDTV/streams",
    availability: "unverified"
  },
  {
    id: "wion",
    name: "WION",
    region: "Asia",
    mode: "link",
    fallbackUrl: "https://www.youtube.com/@WION/streams",
    availability: "unverified"
  },
  {
    id: "cna",
    name: "CNA",
    region: "Asia",
    mode: "link",
    fallbackUrl: "https://www.youtube.com/@ChannelNewsAsia/streams",
    availability: "unverified"
  },
  {
    id: "africa-news",
    name: "Africanews",
    region: "Africa",
    mode: "link",
    fallbackUrl: "https://www.youtube.com/@africanews/streams",
    availability: "unverified"
  },
  {
    id: "sky-aus",
    name: "Sky News Australia",
    region: "Oceania",
    mode: "link",
    fallbackUrl: "https://www.youtube.com/@SkyNewsAustralia/streams",
    availability: "unverified"
  }
];

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildYoutubeThumbnailUrl(videoId = "") {
  const normalized = String(videoId || "").trim();
  return /^[a-zA-Z0-9_-]{11}$/.test(normalized) ? `https://i.ytimg.com/vi/${normalized}/hqdefault.jpg` : "";
}

function normalizeVideoStreams(items = []) {
  if (!Array.isArray(items) || !items.length) {
    return [...VIDEO_STREAMS];
  }

  return items.map((item, index) => ({
    id: String(item?.id || `video-${index + 1}`),
    name: String(item?.name || "Unknown Stream"),
    region: String(item?.region || "Global"),
    provider: String(item?.provider || item?.kind || "youtube"),
    mode: item?.mode === "embed" && item?.embedUrl ? "embed" : item?.mode === "hls" ? "hls" : "external",
    channelId: item?.channelId ? String(item.channelId) : "",
    handle: item?.handle || item?.channelHandle ? String(item.handle || item.channelHandle) : "",
    videoId: item?.videoId ? String(item.videoId) : "",
    embedUrl: String(item?.embedUrl || ""),
    channelEmbedUrl: String(item?.channelEmbedUrl || ""),
    fallbackUrl: String(item?.fallbackUrl || item?.watchUrl || "#"),
    priority: String(item?.priority || "normal"),
    enabled: item?.enabled !== false,
    availability: String(item?.availability || "unverified"),
    resolvedAt: item?.resolvedAt ? String(item.resolvedAt) : "",
    cacheAgeSec: Number.isFinite(Number(item?.cacheAgeSec)) ? Number(item.cacheAgeSec) : null,
    nextResolveAt: item?.nextResolveAt ? String(item.nextResolveAt) : "",
    errorReason: item?.errorReason ? String(item.errorReason) : "",
    metadata: item?.metadata && typeof item.metadata === "object" ? item.metadata : {}
  }));
}

function regionOrder(items = []) {
  return [...new Set(items.map((item) => item.region))];
}

function renderPlayerContent(item, { activated = false } = {}) {
  if (!item) {
    return '<div class="situational-placeholder">Select a stream to monitor.</div>';
  }

  const fallbackLink = `
    <a class="btn btn-sm btn-outline-info" href="${escapeHtml(item.fallbackUrl)}" target="_blank" rel="noopener noreferrer">
      Open stream on YouTube
    </a>
  `;
  const status = renderAvailabilityBadge(item.availability);
  const errorMeta = item.errorReason
    ? `<div class="small text-light-emphasis mt-2">Reason: ${escapeHtml(item.errorReason)}</div>`
    : "";

  if (item.mode === "embed" && item.embedUrl) {
    if (!activated) {
      const thumbnailUrl = buildYoutubeThumbnailUrl(item.videoId);
      const thumbnail = thumbnailUrl
        ? `<img src="${escapeHtml(thumbnailUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
        : '<div class="situational-player-placeholder-empty"></div>';
      return `
        <div class="situational-player-placeholder">
          ${thumbnail}
          <div class="situational-player-placeholder-overlay">
            <div>
              <div class="situational-stream-status mb-3">${status}${renderCacheMeta(item)}</div>
              <button class="btn btn-sm btn-outline-info" type="button" data-video-action="play">Load live stream</button>
            </div>
          </div>
        </div>
        <div class="situational-player-footer">
          <div class="situational-stream-status">${status}${renderCacheMeta(item)}</div>
          ${fallbackLink}
        </div>
      `;
    }

    return `
      <div class="situational-player-frame">
        <iframe
          src="${escapeHtml(item.embedUrl)}"
          title="${escapeHtml(item.name)}"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowfullscreen
          loading="lazy"
          referrerpolicy="strict-origin-when-cross-origin"
        ></iframe>
      </div>
      <div class="situational-player-footer">
        <div class="situational-stream-status">${status}${renderCacheMeta(item)}</div>
        ${fallbackLink}
      </div>
    `;
  }

  return `
    <div class="situational-placeholder">
      <div>
        <p class="mb-3">${escapeHtml(item.name)} is catalogued for rapid operator handoff.</p>
        <div class="mb-3">${status}${errorMeta}</div>
        <button class="btn btn-sm btn-outline-light me-2" type="button" data-video-action="refresh">Retry</button>
        ${fallbackLink}
      </div>
    </div>
  `;
}

function availabilityLabel(value = "") {
  const labels = {
    live_verified: "Live verified",
    cached_verified: "Cached",
    manual_fallback: "Manual",
    channel_fallback: "Not verified",
    last_known_stale: "Stale",
    quota_limited: "Quota limited",
    unavailable: "Unavailable",
    error: "Error",
    unverified: "Unverified"
  };
  return labels[value] || value || "Unverified";
}

function availabilityClass(value = "") {
  if (["live_verified", "cached_verified"].includes(value)) {
    return "ok";
  }
  if (["manual_fallback", "channel_fallback", "last_known_stale", "quota_limited"].includes(value)) {
    return "partial";
  }
  if (["error", "unavailable"].includes(value)) {
    return "error";
  }
  return "idle";
}

function renderAvailabilityBadge(value = "") {
  return `<span class="diagnostic-pill ${availabilityClass(value)}">${escapeHtml(availabilityLabel(value))}</span>`;
}

function renderCacheMeta(item = {}) {
  const parts = [];
  if (Number.isFinite(Number(item.cacheAgeSec))) {
    parts.push(`age ${Math.max(0, Number(item.cacheAgeSec))}s`);
  }
  if (item.nextResolveAt) {
    parts.push(`next ${new Date(item.nextResolveAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
  }
  if (item.errorReason) {
    parts.push(item.errorReason);
  }
  if (!parts.length) {
    return "";
  }
  return `<span class="small text-light-emphasis">${escapeHtml(parts.join(" | "))}</span>`;
}

function renderRegions(regions = [], selectedRegion = "") {
  return regions
    .map((region) => {
      const active = region === selectedRegion ? "active" : "";
      return `<button class="situational-region-chip ${active}" type="button" data-region="${escapeHtml(region)}">${escapeHtml(region)}</button>`;
    })
    .join("");
}

function renderList(items = [], selectedId = "") {
  return items
    .map((item) => {
      const active = item.id === selectedId ? "active" : "";
      const modeLabel = item.mode === "embed" ? "embedded" : "external";
      const availability = escapeHtml(item.availability || "unverified");
      return `
        <button class="situational-stream-chip ${active}" type="button" data-stream-id="${item.id}">
          <span class="situational-stream-chip-head">
            <strong>${escapeHtml(item.name)}</strong>
            ${renderAvailabilityBadge(item.availability)}
          </span>
          <small>${escapeHtml(item.region)} intel media - ${modeLabel} - ${availability}</small>
        </button>
      `;
    })
    .join("");
}

function resolveArgs(rootIdOrOptions = "video-streams-panel", maybeOptions = {}) {
  if (typeof rootIdOrOptions === "object" && rootIdOrOptions !== null) {
    return {
      rootId: rootIdOrOptions.rootId || "video-streams-panel",
      streams: rootIdOrOptions.streams || [],
      selectedRegion: rootIdOrOptions.selectedRegion || "",
      selectedId: rootIdOrOptions.selectedId || "",
      onVisibleStream:
        typeof rootIdOrOptions.onVisibleStream === "function" ? rootIdOrOptions.onVisibleStream : null,
      onRefreshStream:
        typeof rootIdOrOptions.onRefreshStream === "function" ? rootIdOrOptions.onRefreshStream : null,
      onSelectionChange:
        typeof rootIdOrOptions.onSelectionChange === "function" ? rootIdOrOptions.onSelectionChange : null
    };
  }

  return {
    rootId: rootIdOrOptions || "video-streams-panel",
    streams: maybeOptions.streams || [],
    selectedRegion: maybeOptions.selectedRegion || "",
    selectedId: maybeOptions.selectedId || "",
    onVisibleStream: typeof maybeOptions.onVisibleStream === "function" ? maybeOptions.onVisibleStream : null,
    onRefreshStream: typeof maybeOptions.onRefreshStream === "function" ? maybeOptions.onRefreshStream : null,
    onSelectionChange: typeof maybeOptions.onSelectionChange === "function" ? maybeOptions.onSelectionChange : null
  };
}

export function mountVideoStreams(rootIdOrOptions = "video-streams-panel", maybeOptions = {}) {
  const {
    rootId,
    streams,
    selectedRegion: initialRegion,
    selectedId: initialId,
    onSelectionChange,
    onVisibleStream,
    onRefreshStream
  } = resolveArgs(
    rootIdOrOptions,
    maybeOptions
  );
  const root = document.getElementById(rootId);
  if (!root) {
    return {
      destroy() {},
      update() {},
      getSelection() {
        return {
          selectedRegion: "",
          selectedId: ""
        };
      },
      getPlaybackSignature() {
        return "";
      }
    };
  }

  root.innerHTML = `
    <div class="situational-stack">
      <div class="situational-player-card">
        <div class="situational-player-header">
          <div>
            <strong data-video-field="name">Stream</strong>
            <div class="small text-light-emphasis" data-video-field="region">Global watchlist stream</div>
          </div>
          <div class="situational-player-actions">
            <button class="btn btn-sm btn-outline-info" type="button" data-video-action="refresh">Refresh</button>
            <button class="btn btn-sm btn-outline-light" type="button" data-video-action="fullscreen">Fullscreen</button>
          </div>
        </div>
        <div data-video-player></div>
      </div>
      <div class="situational-region-bar" data-video-regions></div>
      <div class="situational-stream-browser">
        <div class="situational-browser-head">
          <strong data-video-browser-title>Global sources</strong>
          <span class="small text-light-emphasis" data-video-browser-count>0 available</span>
        </div>
        <div class="situational-stream-list" data-video-list></div>
      </div>
    </div>
  `;

  const playerShell = root.querySelector("[data-video-player]");
  const regionShell = root.querySelector("[data-video-regions]");
  const listShell = root.querySelector("[data-video-list]");
  const browserTitle = root.querySelector("[data-video-browser-title]");
  const browserCount = root.querySelector("[data-video-browser-count]");
  const streamName = root.querySelector("[data-video-field='name']");
  const streamRegion = root.querySelector("[data-video-field='region']");

  let sourceStreams = normalizeVideoStreams(streams);
  let selection = resolveVideoStreamSelection(sourceStreams, {
    selectedRegion: initialRegion,
    selectedId: initialId
  });
  let playbackSignature = "";
  let emittedSelectionSignature = "";
  let emittedVisibleStreamId = "";
  const activatedStreamIds = new Set();

  function emitSelection() {
    const selectionSignature = `${selection.selectedRegion}|${selection.selectedId}`;
    if (selectionSignature !== emittedSelectionSignature) {
      emittedSelectionSignature = selectionSignature;
      onSelectionChange?.({
        selectedRegion: selection.selectedRegion,
        selectedId: selection.selectedId
      });
    }
    if (selection.selectedId && selection.selectedId !== emittedVisibleStreamId) {
      emittedVisibleStreamId = selection.selectedId;
      onVisibleStream?.(selection.selectedId);
    }
  }

  function renderChrome() {
    const selected = selection.selected;
    streamName.textContent = selected?.name || "Stream";
    streamRegion.textContent = `${selected?.region || "Global"} watchlist stream`;
    regionShell.innerHTML = renderRegions(selection.regions, selection.selectedRegion);
    listShell.innerHTML = renderList(selection.filteredStreams, selection.selectedId);
    browserTitle.textContent = `${selection.selectedRegion || "Global"} sources`;
    browserCount.textContent = `${selection.filteredStreams.length} available`;
  }

  function renderPlayer() {
    const playerActivated = selection.selectedId ? activatedStreamIds.has(selection.selectedId) : false;
    const nextSignature = [
      buildStreamPlaybackSignature(selection.selected),
      selection.selected?.availability || "",
      selection.selected?.errorReason || "",
      selection.selected?.cacheAgeSec ?? "",
      playerActivated ? "active" : "placeholder"
    ].join("|");
    if (nextSignature === playbackSignature) {
      return;
    }
    playerShell.innerHTML = renderPlayerContent(selection.selected, { activated: playerActivated });
    playbackSignature = nextSignature;
  }

  function rerender() {
    renderChrome();
    renderPlayer();
    emitSelection();
  }

  function handleClick(event) {
    const regionButton = event.target.closest("[data-region]");
    if (regionButton) {
      selection = resolveVideoStreamSelection(sourceStreams, {
        selectedRegion: regionButton.dataset.region || selection.selectedRegion,
        selectedId: ""
      });
      rerender();
      return;
    }

    const streamButton = event.target.closest("[data-stream-id]");
    if (streamButton) {
      selection = resolveVideoStreamSelection(sourceStreams, {
        selectedRegion: selection.selectedRegion,
        selectedId: streamButton.dataset.streamId || selection.selectedId
      });
      rerender();
      return;
    }

    if (event.target.closest("[data-video-action='fullscreen']")) {
      root.querySelector(".situational-player-frame")?.requestFullscreen?.();
      return;
    }

    if (event.target.closest("[data-video-action='play']")) {
      if (selection.selectedId) {
        activatedStreamIds.add(selection.selectedId);
        renderPlayer();
      }
      return;
    }

    if (event.target.closest("[data-video-action='refresh']")) {
      if (selection.selectedId) {
        onRefreshStream?.(selection.selectedId);
      }
    }
  }

  root.addEventListener("click", handleClick);
  rerender();

  return {
    update(nextStreams = [], nextState = {}) {
      sourceStreams = normalizeVideoStreams(nextStreams);
      selection = resolveVideoStreamSelection(sourceStreams, {
        selectedRegion: nextState.selectedRegion ?? selection.selectedRegion,
        selectedId: nextState.selectedId ?? selection.selectedId
      });
      rerender();
    },
    destroy() {
      root.removeEventListener("click", handleClick);
      activatedStreamIds.clear();
      root.innerHTML = "";
    },
    getSelection() {
      return {
        selectedRegion: selection.selectedRegion,
        selectedId: selection.selectedId
      };
    },
    getPlaybackSignature() {
      return playbackSignature;
    }
  };
}

export { VIDEO_STREAMS, normalizeVideoStreams };
