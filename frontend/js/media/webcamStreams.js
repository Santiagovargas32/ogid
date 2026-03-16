import { buildCollectionPlaybackSignature, buildStreamPlaybackSignature } from "./mediaPlaybackPolicy.js";

const WEBCAM_STREAMS = [
  {
    id: "strait-hormuz",
    name: "Strait of Hormuz",
    category: "Shipping Chokepoints",
    mode: "link",
    fallbackUrl: "https://www.marinetraffic.com/",
    availability: "unverified"
  },
  {
    id: "bab-el-mandeb",
    name: "Bab el-Mandeb",
    category: "Shipping Chokepoints",
    mode: "link",
    fallbackUrl: "https://www.marinetraffic.com/",
    availability: "unverified"
  },
  {
    id: "suez",
    name: "Suez Canal",
    category: "Shipping Chokepoints",
    mode: "link",
    fallbackUrl: "https://www.earthcam.com/",
    availability: "unverified"
  },
  {
    id: "panama",
    name: "Panama Canal",
    category: "Shipping Chokepoints",
    mode: "link",
    fallbackUrl: "https://www.pancanal.com/en/webcams/",
    availability: "unverified"
  },
  {
    id: "gibraltar",
    name: "Gibraltar Strait",
    category: "Shipping Chokepoints",
    mode: "link",
    fallbackUrl: "https://www.earthcam.com/",
    availability: "unverified"
  },
  {
    id: "haifa-port",
    name: "Haifa Port",
    category: "Strategic Ports",
    mode: "link",
    fallbackUrl: "https://www.youtube.com/results?search_query=Haifa+Port+live",
    availability: "unverified"
  },
  {
    id: "singapore-port",
    name: "Singapore Port",
    category: "Strategic Ports",
    mode: "link",
    fallbackUrl: "https://www.youtube.com/results?search_query=Singapore+Port+live",
    availability: "unverified"
  },
  {
    id: "tel-aviv",
    name: "Tel Aviv Coastline",
    category: "Middle East Monitoring",
    mode: "link",
    fallbackUrl: "https://www.youtube.com/results?search_query=Tel+Aviv+live+cam",
    availability: "unverified"
  },
  {
    id: "jerusalem",
    name: "Jerusalem Skyline",
    category: "Middle East Monitoring",
    mode: "link",
    fallbackUrl: "https://www.youtube.com/results?search_query=Jerusalem+live+cam",
    availability: "unverified"
  },
  {
    id: "beirut",
    name: "Beirut Harbor",
    category: "Middle East Monitoring",
    mode: "link",
    fallbackUrl: "https://www.youtube.com/results?search_query=Beirut+live+cam",
    availability: "unverified"
  },
  {
    id: "taipei",
    name: "Taipei Skyline",
    category: "Global Hotspots",
    mode: "link",
    fallbackUrl: "https://www.youtube.com/results?search_query=Taipei+live+cam",
    availability: "unverified"
  },
  {
    id: "kyiv",
    name: "Kyiv Center",
    category: "Conflict Zones",
    mode: "link",
    fallbackUrl: "https://www.youtube.com/results?search_query=Kyiv+live+cam",
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

function normalizeWebcamStreams(items = []) {
  if (!Array.isArray(items) || !items.length) {
    return [...WEBCAM_STREAMS];
  }

  return items.map((item, index) => ({
    id: String(item?.id || `webcam-${index + 1}`),
    name: String(item?.name || "Unknown Webcam"),
    category: String(item?.category || item?.region || "Operational Feed"),
    mode: item?.mode === "embed" && item?.embedUrl ? "embed" : "link",
    embedUrl: String(item?.embedUrl || ""),
    fallbackUrl: String(item?.fallbackUrl || item?.watchUrl || "#"),
    availability: String(item?.availability || "unverified")
  }));
}

function renderFrame(item) {
  if (item.mode === "embed" && item.embedUrl) {
    return `
      <div class="webcam-card-frame">
        <iframe
          src="${escapeHtml(item.embedUrl)}"
          title="${escapeHtml(item.name)}"
          loading="lazy"
          allowfullscreen
          referrerpolicy="origin"
        ></iframe>
      </div>
    `;
  }

  return `
    <div class="webcam-card-frame">
      <div class="webcam-card-frame-fallback">
        <div>
          <strong class="d-block mb-2">External live source</strong>
          <div class="small text-light-emphasis">Embed remains disabled until the source is verified as frame-safe.</div>
        </div>
      </div>
    </div>
  `;
}

function resolveArgs(rootIdOrOptions = "webcam-streams-panel", maybeOptions = {}) {
  if (typeof rootIdOrOptions === "object" && rootIdOrOptions !== null) {
    return {
      rootId: rootIdOrOptions.rootId || "webcam-streams-panel",
      streams: rootIdOrOptions.streams || []
    };
  }

  return {
    rootId: rootIdOrOptions || "webcam-streams-panel",
    streams: maybeOptions.streams || []
  };
}

export function mountWebcamStreams(rootIdOrOptions = "webcam-streams-panel", maybeOptions = {}) {
  const { rootId, streams } = resolveArgs(rootIdOrOptions, maybeOptions);
  const root = document.getElementById(rootId);
  if (!root) {
    return {
      destroy() {},
      update() {},
      getPlaybackSignature() {
        return "";
      }
    };
  }

  root.innerHTML = `
    <div class="webcam-grid" data-webcam-grid></div>
  `;
  const grid = root.querySelector("[data-webcam-grid]");
  const cards = new Map();
  let sourceStreams = normalizeWebcamStreams(streams);
  let collectionSignature = "";

  function renderMeta(item) {
    return `
      <div class="webcam-card-header">
        <strong>${escapeHtml(item.name)}</strong>
        <span>${escapeHtml(item.category)}</span>
      </div>
      <div class="small text-light-emphasis">Rapid drill-down camera catalog for chokepoints, ports and frontline cities.</div>
      <div class="small text-light-emphasis text-uppercase">Status: ${escapeHtml(item.availability)}</div>
      <a class="btn btn-sm btn-outline-info" href="${escapeHtml(item.fallbackUrl)}" target="_blank" rel="noopener noreferrer">Open webcam source</a>
    `;
  }

  function ensureCard(item) {
    let record = cards.get(item.id);
    if (!record) {
      const element = document.createElement("article");
      element.className = "webcam-card";
      const frameShell = document.createElement("div");
      const metaShell = document.createElement("div");
      element.append(frameShell, metaShell);
      record = {
        element,
        frameShell,
        metaShell,
        playbackSignature: ""
      };
      cards.set(item.id, record);
    }

    const nextPlaybackSignature = buildStreamPlaybackSignature(item);
    if (nextPlaybackSignature !== record.playbackSignature) {
      record.frameShell.innerHTML = renderFrame(item);
      record.playbackSignature = nextPlaybackSignature;
    }
    record.metaShell.innerHTML = renderMeta(item);
    return record.element;
  }

  function rerender() {
    collectionSignature = buildCollectionPlaybackSignature(sourceStreams);
    const activeIds = new Set(sourceStreams.map((item) => item.id));

    cards.forEach((record, id) => {
      if (!activeIds.has(id)) {
        record.element.remove();
        cards.delete(id);
      }
    });

    sourceStreams.forEach((item) => {
      const element = ensureCard(item);
      grid.appendChild(element);
    });
  }

  rerender();

  return {
    update(nextStreams = []) {
      sourceStreams = normalizeWebcamStreams(nextStreams);
      rerender();
    },
    destroy() {
      root.innerHTML = "";
    },
    getPlaybackSignature() {
      return collectionSignature;
    }
  };
}

export { WEBCAM_STREAMS, normalizeWebcamStreams };
