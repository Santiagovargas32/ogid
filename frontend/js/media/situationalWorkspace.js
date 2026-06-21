import { SmartPollLoop } from "../smartPollLoop.js";
import { mountVideoStreams, VIDEO_STREAMS } from "./videoStreams.js";
import { mountWebcamStreams, WEBCAM_STREAMS } from "./webcamStreams.js";

const VIEW_LABELS = {
  situational: "Live Situational Awareness",
  webcams: "Hotspot Webcams"
};

const TRANSITION_MS = 190;
const FOREGROUND_REFRESH_MS = 10 * 60_000;
const HIDDEN_REFRESH_MS = 45 * 60_000;

function normalizeMediaPayload(payload = {}) {
  const situational = Array.isArray(payload?.sections?.situational) && payload.sections.situational.length
    ? payload.sections.situational
    : VIDEO_STREAMS;
  const webcams = Array.isArray(payload?.sections?.webcams) && payload.sections.webcams.length
    ? payload.sections.webcams
    : WEBCAM_STREAMS;

  return {
    generatedAt: payload?.generatedAt || null,
    summary: payload?.summary || {},
    sections: {
      situational,
      webcams
    }
  };
}

function mergeSituationalStreams(current = [], changed = []) {
  if (!Array.isArray(changed) || !changed.length) {
    return current;
  }

  const changedById = new Map(changed.map((item) => [String(item.id || ""), item]).filter(([id]) => id));
  return current.map((item) => changedById.get(item.id) || item);
}

function renderToggleMarkup(activeView = "situational") {
  return `
    <details class="situational-view-dropdown">
      <summary class="situational-view-summary">
        <span class="situational-view-label">${VIEW_LABELS[activeView] || VIEW_LABELS.situational}</span>
      </summary>
      <div class="situational-view-menu">
        <button class="situational-view-option ${activeView === "situational" ? "active" : ""}" type="button" data-situational-view="situational">
          ${VIEW_LABELS.situational}
        </button>
        <button class="situational-view-option ${activeView === "webcams" ? "active" : ""}" type="button" data-situational-view="webcams">
          ${VIEW_LABELS.webcams}
        </button>
      </div>
    </details>
  `;
}

export function mountSituationalWorkspace({
  api = null,
  rootId = "situational-workspace-panel",
  toggleRootId = "situational-view-toggle-shell"
} = {}) {
  const root = document.getElementById(rootId);
  const toggleRoot = document.getElementById(toggleRootId);
  if (!root) {
    return () => {};
  }

  const workspaceId = `${rootId}-workspace`;
  root.innerHTML = `<div id="${workspaceId}" class="situational-workspace-body"></div>`;
  const workspace = root.querySelector(`#${workspaceId}`);
  if (!workspace) {
    return () => {};
  }

  let mediaPayload = normalizeMediaPayload({});
  let activeView = "situational";
  let transitioning = false;
  let currentController = null;
  let mediaPoller = null;
  const visibleResolveInFlight = new Set();
  const viewState = {
    situational: {
      selectedRegion: "",
      selectedId: ""
    }
  };

  function destroyCurrentView() {
    viewState.situational = currentController?.getSelection?.() || viewState.situational;
    currentController?.destroy?.();
    currentController = null;
  }

  function updateCurrentView() {
    if (!currentController) {
      mountCurrentView();
      return;
    }

    if (activeView === "webcams") {
      currentController.update?.(mediaPayload.sections.webcams);
      return;
    }

    currentController.update?.(mediaPayload.sections.situational, viewState.situational);
  }

  async function loadMediaStreams({ resolve = "critical", ids = [], force = false } = {}) {
    if (!api?.getMediaStreams) {
      mediaPayload = normalizeMediaPayload({});
      return mediaPayload;
    }

    const params = {
      resolve,
      ids: Array.isArray(ids) ? ids : [ids],
      force: force ? 1 : undefined
    };
    const payload = await api.getMediaStreams(params);
    mediaPayload = normalizeMediaPayload(payload);
    return mediaPayload;
  }

  async function refreshAndRender(options = {}) {
    try {
      await loadMediaStreams(options);
      if (!transitioning) {
        updateCurrentView();
      }
    } catch {
      mediaPayload = normalizeMediaPayload(mediaPayload);
    }
    return mediaPayload;
  }

  async function resolveVisibleStream(streamId = "") {
    const id = String(streamId || "").trim();
    if (!id || visibleResolveInFlight.has(id) || activeView !== "situational") {
      return;
    }

    visibleResolveInFlight.add(id);
    try {
      await refreshAndRender({
        resolve: "visible",
        ids: [id],
        force: false
      });
    } finally {
      visibleResolveInFlight.delete(id);
    }
  }

  async function refreshStream(streamId = "") {
    const id = String(streamId || "").trim();
    if (!id || !api?.refreshMediaStreams) {
      return;
    }

    try {
      const payload = await api.refreshMediaStreams({
        ids: [id],
        force: true
      });
      mediaPayload = normalizeMediaPayload(payload);
      updateCurrentView();
    } catch {
      await resolveVisibleStream(id);
    }
  }

  function mountCurrentView() {
    destroyCurrentView();
    if (activeView === "webcams") {
      currentController = mountWebcamStreams({
        rootId: workspaceId,
        streams: mediaPayload.sections.webcams
      });
      return;
    }

    currentController = mountVideoStreams({
      rootId: workspaceId,
      streams: mediaPayload.sections.situational,
      selectedRegion: viewState.situational.selectedRegion,
      selectedId: viewState.situational.selectedId,
      onSelectionChange(selection) {
        viewState.situational = selection;
      },
      onVisibleStream(streamId) {
        resolveVisibleStream(streamId);
      },
      onRefreshStream(streamId) {
        refreshStream(streamId);
      }
    });
  }

  function bindToggleEvents() {
    if (!toggleRoot) {
      return;
    }

    const details = toggleRoot.querySelector(".situational-view-dropdown");
    toggleRoot.querySelectorAll("[data-situational-view]").forEach((button) => {
      button.addEventListener("click", () => {
        const requestedView = button.dataset.situationalView;
        if (!requestedView || requestedView === activeView || transitioning) {
          details?.removeAttribute("open");
          return;
        }

        transitioning = true;
        workspace.classList.add("situational-view-transition-out");
        window.setTimeout(() => {
          activeView = requestedView;
          mountCurrentView();
          workspace.classList.remove("situational-view-transition-out");
          workspace.classList.add("situational-view-transition-in");
          window.requestAnimationFrame(() => {
            workspace.classList.remove("situational-view-transition-in");
            transitioning = false;
            if (activeView === "situational" && viewState.situational.selectedId) {
              resolveVisibleStream(viewState.situational.selectedId);
            }
          });
          toggleRoot.innerHTML = renderToggleMarkup(activeView);
          bindToggleEvents();
        }, TRANSITION_MS);
      });
    });
  }

  function buildPollOptions() {
    if (activeView === "situational" && viewState.situational.selectedId) {
      return {
        resolve: "visible",
        ids: [viewState.situational.selectedId]
      };
    }

    return {
      resolve: "critical"
    };
  }

  function startMediaPoller() {
    mediaPoller?.stop?.();
    mediaPoller = new SmartPollLoop({
      immediate: false,
      intervalMs: FOREGROUND_REFRESH_MS,
      hiddenIntervalMs: HIDDEN_REFRESH_MS,
      task: () => refreshAndRender(buildPollOptions()),
      onError(error) {
        console.error("media stream refresh failed", error);
      }
    });
    mediaPoller.start();
  }

  function handleMediaStreamUpdate(event) {
    const changedStreams = event?.detail?.changedStreams || [];
    if (!Array.isArray(changedStreams) || !changedStreams.length) {
      return;
    }
    mediaPayload = {
      ...mediaPayload,
      generatedAt: event?.detail?.updatedAt || mediaPayload.generatedAt,
      sections: {
        ...mediaPayload.sections,
        situational: mergeSituationalStreams(mediaPayload.sections.situational, changedStreams)
      }
    };
    if (!transitioning && activeView === "situational") {
      updateCurrentView();
    }
  }

  async function initialize() {
    try {
      await loadMediaStreams({ resolve: "critical" });
    } catch {
      mediaPayload = normalizeMediaPayload(mediaPayload);
    }
    toggleRoot?.replaceChildren();
    if (toggleRoot) {
      toggleRoot.innerHTML = renderToggleMarkup(activeView);
      bindToggleEvents();
    }
    mountCurrentView();
    startMediaPoller();
    window.addEventListener("media:streams:updated", handleMediaStreamUpdate);
  }

  initialize();

  return () => {
    mediaPoller?.stop?.();
    window.removeEventListener("media:streams:updated", handleMediaStreamUpdate);
    destroyCurrentView();
    root.innerHTML = "";
    if (toggleRoot) {
      toggleRoot.innerHTML = "";
    }
  };
}
