import { mountVideoStreams, VIDEO_STREAMS } from "./videoStreams.js";
import { mountWebcamStreams, WEBCAM_STREAMS } from "./webcamStreams.js";

const VIEW_LABELS = {
  situational: "Live Situational Awareness",
  webcams: "Hotspot Webcams"
};

const TRANSITION_MS = 190;
const REFRESH_INTERVAL_MS = 60_000;

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
  let refreshInterval = null;
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
      }
    });
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
          });
          toggleRoot.innerHTML = renderToggleMarkup(activeView);
          bindToggleEvents();
        }, TRANSITION_MS);
      });
    });
  }

  async function refreshMediaStreams(force = false) {
    if (!api?.getMediaStreams) {
      mediaPayload = normalizeMediaPayload({});
      return;
    }

    try {
      const payload = await api.getMediaStreams(force ? { force: 1 } : {});
      mediaPayload = normalizeMediaPayload(payload);
    } catch {
      mediaPayload = normalizeMediaPayload(mediaPayload);
    }
  }

  async function initialize() {
    await refreshMediaStreams(false);
    toggleRoot?.replaceChildren();
    if (toggleRoot) {
      toggleRoot.innerHTML = renderToggleMarkup(activeView);
      bindToggleEvents();
    }
    mountCurrentView();
    refreshInterval = window.setInterval(async () => {
      await refreshMediaStreams(false);
      if (!transitioning) {
        updateCurrentView();
      }
    }, REFRESH_INTERVAL_MS);
  }

  initialize();

  return () => {
    window.clearInterval(refreshInterval);
    destroyCurrentView();
    root.innerHTML = "";
    if (toggleRoot) {
      toggleRoot.innerHTML = "";
    }
  };
}
