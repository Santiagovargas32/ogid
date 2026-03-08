const VIDEO_STREAMS = [
  {
    id: "bloomberg",
    name: "Bloomberg",
    region: "Global",
    mode: "embed",
    embedUrl: "https://www.youtube.com/embed/live_stream?channel=UCIALMKvObZNtJ6AmdCLP7Lg",
    fallbackUrl: "https://www.youtube.com/@BloombergTV/live"
  },
  {
    id: "reuters",
    name: "Reuters",
    region: "Global",
    mode: "embed",
    embedUrl: "https://www.youtube.com/embed/live_stream?channel=UChqUTb7kYRX8-EiaN3XFrSQ",
    fallbackUrl: "https://www.youtube.com/@Reuters/live"
  },
  {
    id: "sky-news",
    name: "Sky News",
    region: "Europe",
    mode: "embed",
    embedUrl: "https://www.youtube.com/embed/live_stream?channel=UCoMdktPbSTixAyNGwb-UYkQ",
    fallbackUrl: "https://www.youtube.com/@SkyNews/live"
  },
  {
    id: "france24",
    name: "France 24",
    region: "Europe",
    mode: "embed",
    embedUrl: "https://www.youtube.com/embed/live_stream?channel=UCE9-RvWlHixPLyGQk9TRj3Q",
    fallbackUrl: "https://www.youtube.com/@FRANCE24/live"
  },
  {
    id: "dw",
    name: "DW News",
    region: "Europe",
    mode: "embed",
    embedUrl: "https://www.youtube.com/embed/live_stream?channel=UCknLrEdhRCp1aegoMqRaCZg",
    fallbackUrl: "https://www.youtube.com/@dwnews/live"
  },
  {
    id: "al-jazeera",
    name: "Al Jazeera English",
    region: "MENA",
    mode: "embed",
    embedUrl: "https://www.youtube.com/embed/live_stream?channel=UCR0DUmNzPhLyX6wnmvvEgKA",
    fallbackUrl: "https://www.youtube.com/@aljazeeraenglish/live"
  },
  {
    id: "i24",
    name: "i24NEWS",
    region: "MENA",
    mode: "link",
    fallbackUrl: "https://www.youtube.com/@i24NEWS/live"
  },
  {
    id: "abc-news",
    name: "ABC News",
    region: "Americas",
    mode: "embed",
    embedUrl: "https://www.youtube.com/embed/live_stream?channel=UCBi2mrWuNuyYy4gbM6fU18Q",
    fallbackUrl: "https://www.youtube.com/@ABCNews/live"
  },
  {
    id: "cbs-news",
    name: "CBS News",
    region: "Americas",
    mode: "embed",
    embedUrl: "https://www.youtube.com/embed/live_stream?channel=UC8p1vwvWtl6T73JiExfWs1g",
    fallbackUrl: "https://www.youtube.com/@CBSNews/live"
  },
  {
    id: "nbc-news",
    name: "NBC News",
    region: "Americas",
    mode: "embed",
    embedUrl: "https://www.youtube.com/embed/live_stream?channel=UCeY0bbntWzzVIaj2z3QigXg",
    fallbackUrl: "https://www.youtube.com/@NBCNews/live"
  },
  {
    id: "cbc-news",
    name: "CBC News",
    region: "Americas",
    mode: "link",
    fallbackUrl: "https://www.youtube.com/@CBCNews/live"
  },
  {
    id: "euronews",
    name: "Euronews",
    region: "Europe",
    mode: "embed",
    embedUrl: "https://www.youtube.com/embed/live_stream?channel=UCSrZ3UV4jOidv8ppoVuvW9Q",
    fallbackUrl: "https://www.youtube.com/@euronews/live"
  },
  {
    id: "ndtv",
    name: "NDTV",
    region: "Asia",
    mode: "link",
    fallbackUrl: "https://www.youtube.com/@NDTV/live"
  },
  {
    id: "wion",
    name: "WION",
    region: "Asia",
    mode: "link",
    fallbackUrl: "https://www.youtube.com/@WION/live"
  },
  {
    id: "cna",
    name: "CNA",
    region: "Asia",
    mode: "link",
    fallbackUrl: "https://www.youtube.com/@ChannelNewsAsia/live"
  },
  {
    id: "africa-news",
    name: "Africanews",
    region: "Africa",
    mode: "link",
    fallbackUrl: "https://www.youtube.com/@africanews/live"
  },
  {
    id: "sky-aus",
    name: "Sky News Australia",
    region: "Oceania",
    mode: "link",
    fallbackUrl: "https://www.youtube.com/@SkyNewsAustralia/live"
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

function regionOrder(items = []) {
  return [...new Set(items.map((item) => item.region))];
}

function renderPlayer(item) {
  if (!item) {
    return '<div class="situational-placeholder">Select a stream to monitor.</div>';
  }

  if (item.mode === "embed" && item.embedUrl) {
    return `
      <div class="situational-player-frame">
        <iframe
          src="${escapeHtml(item.embedUrl)}"
          title="${escapeHtml(item.name)}"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
          allowfullscreen
          loading="lazy"
          referrerpolicy="origin"
        ></iframe>
      </div>
    `;
  }

  return `
    <div class="situational-placeholder">
      <div>
        <p class="mb-3">${escapeHtml(item.name)} is catalogued for rapid operator handoff.</p>
        <a class="btn btn-sm btn-outline-info" href="${escapeHtml(item.fallbackUrl)}" target="_blank" rel="noopener noreferrer">Open source</a>
      </div>
    </div>
  `;
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
      return `
        <button class="situational-stream-chip ${active}" type="button" data-stream-id="${item.id}">
          <strong>${escapeHtml(item.name)}</strong>
          <small>${escapeHtml(item.region)} intel media · ${modeLabel}</small>
        </button>
      `;
    })
    .join("");
}

export function mountVideoStreams(rootId = "video-streams-panel") {
  const root = document.getElementById(rootId);
  if (!root) {
    return () => {};
  }

  const regions = regionOrder(VIDEO_STREAMS);
  let selectedRegion = regions[0] || "";
  let selectedId = VIDEO_STREAMS.find((item) => item.region === selectedRegion)?.id || VIDEO_STREAMS[0]?.id || "";

  function render() {
    const filteredStreams = VIDEO_STREAMS.filter((item) => item.region === selectedRegion);
    const selected = filteredStreams.find((item) => item.id === selectedId) || filteredStreams[0] || VIDEO_STREAMS[0];
    selectedId = selected?.id || "";

    root.innerHTML = `
      <div class="situational-stack">
        <div class="situational-player-card">
          <div class="situational-player-header">
            <div>
              <strong>${escapeHtml(selected?.name || "Stream")}</strong>
              <div class="small text-light-emphasis">${escapeHtml(selected?.region || "Global")} watchlist stream</div>
            </div>
            <button class="btn btn-sm btn-outline-light" type="button" data-video-action="fullscreen">Fullscreen</button>
          </div>
          ${renderPlayer(selected)}
        </div>
        <div class="situational-region-bar">${renderRegions(regions, selectedRegion)}</div>
        <div class="situational-stream-browser">
          <div class="situational-browser-head">
            <strong>${escapeHtml(selectedRegion || "Global")} sources</strong>
            <span class="small text-light-emphasis">${filteredStreams.length} available</span>
          </div>
          <div class="situational-stream-list">${renderList(filteredStreams, selected?.id)}</div>
        </div>
      </div>
    `;

    root.querySelectorAll("[data-region]").forEach((button) => {
      button.addEventListener("click", () => {
        selectedRegion = button.dataset.region || selectedRegion;
        selectedId = VIDEO_STREAMS.find((item) => item.region === selectedRegion)?.id || selectedId;
        render();
      });
    });

    root.querySelectorAll("[data-stream-id]").forEach((button) => {
      button.addEventListener("click", () => {
        selectedId = button.dataset.streamId || selectedId;
        render();
      });
    });

    root.querySelector("[data-video-action='fullscreen']")?.addEventListener("click", () => {
      root.querySelector(".situational-player-frame")?.requestFullscreen?.();
    });
  }

  render();
  return () => {
    root.innerHTML = "";
  };
}

export { VIDEO_STREAMS };
