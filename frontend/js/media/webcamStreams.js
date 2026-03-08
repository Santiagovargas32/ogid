const WEBCAM_STREAMS = [
  {
    id: "strait-hormuz",
    name: "Strait of Hormuz",
    category: "Shipping Chokepoints",
    mode: "link",
    fallbackUrl: "https://www.marinetraffic.com/"
  },
  {
    id: "bab-el-mandeb",
    name: "Bab el-Mandeb",
    category: "Shipping Chokepoints",
    mode: "link",
    fallbackUrl: "https://www.marinetraffic.com/"
  },
  {
    id: "suez",
    name: "Suez Canal",
    category: "Shipping Chokepoints",
    mode: "link",
    fallbackUrl: "https://www.earthcam.com/"
  },
  {
    id: "panama",
    name: "Panama Canal",
    category: "Shipping Chokepoints",
    mode: "link",
    fallbackUrl: "https://www.pancanal.com/en/webcams/"
  },
  {
    id: "gibraltar",
    name: "Gibraltar Strait",
    category: "Shipping Chokepoints",
    mode: "link",
    fallbackUrl: "https://www.earthcam.com/"
  },
  {
    id: "haifa-port",
    name: "Haifa Port",
    category: "Strategic Ports",
    mode: "link",
    fallbackUrl: "https://www.youtube.com/results?search_query=Haifa+Port+live"
  },
  {
    id: "singapore-port",
    name: "Singapore Port",
    category: "Strategic Ports",
    mode: "link",
    fallbackUrl: "https://www.youtube.com/results?search_query=Singapore+Port+live"
  },
  {
    id: "tel-aviv",
    name: "Tel Aviv Coastline",
    category: "Middle East Monitoring",
    mode: "link",
    fallbackUrl: "https://www.youtube.com/results?search_query=Tel+Aviv+live+cam"
  },
  {
    id: "jerusalem",
    name: "Jerusalem Skyline",
    category: "Middle East Monitoring",
    mode: "link",
    fallbackUrl: "https://www.youtube.com/results?search_query=Jerusalem+live+cam"
  },
  {
    id: "beirut",
    name: "Beirut Harbor",
    category: "Middle East Monitoring",
    mode: "link",
    fallbackUrl: "https://www.youtube.com/results?search_query=Beirut+live+cam"
  },
  {
    id: "taipei",
    name: "Taipei Skyline",
    category: "Global Hotspots",
    mode: "link",
    fallbackUrl: "https://www.youtube.com/results?search_query=Taipei+live+cam"
  },
  {
    id: "kyiv",
    name: "Kyiv Center",
    category: "Conflict Zones",
    mode: "link",
    fallbackUrl: "https://www.youtube.com/results?search_query=Kyiv+live+cam"
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

export function mountWebcamStreams(rootId = "webcam-streams-panel") {
  const root = document.getElementById(rootId);
  if (!root) {
    return () => {};
  }

  root.innerHTML = `
    <div class="webcam-grid">
      ${WEBCAM_STREAMS.map(
        (item) => `
          <article class="webcam-card">
            ${renderFrame(item)}
            <div class="webcam-card-header">
              <strong>${escapeHtml(item.name)}</strong>
              <span>${escapeHtml(item.category)}</span>
            </div>
            <div class="small text-light-emphasis">Rapid drill-down camera catalog for chokepoints, ports and frontline cities.</div>
            <a class="btn btn-sm btn-outline-info" href="${escapeHtml(item.fallbackUrl)}" target="_blank" rel="noopener noreferrer">Open webcam source</a>
          </article>
        `
      ).join("")}
    </div>
  `;

  return () => {
    root.innerHTML = "";
  };
}

export { WEBCAM_STREAMS };
