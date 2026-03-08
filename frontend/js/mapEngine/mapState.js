const STORAGE_KEY = "ogid-map-state";

function cloneState(state = {}) {
  return {
    engine: state.engine || "leaflet",
    preset: state.preset || "Global",
    timeWindow: state.timeWindow || "24h",
    activeLayers: [...new Set(state.activeLayers || [])]
  };
}

export class MapStateStore {
  constructor(config = {}) {
    this.config = config;
    this.subscribers = new Set();
    this.state = this.buildInitialState(config);
  }

  buildInitialState(config = {}) {
    const saved = this.readSavedState();
    const defaultPreset = (config.presets || []).find((preset) => preset.id === "Global") || config.presets?.[0] || {
      id: "Global",
      activeLayers: ["conflicts", "protests", "cyber_incidents", "sanctions"],
      timeWindow: "24h"
    };

    return cloneState({
      engine: saved.engine || config.engine?.default || "leaflet",
      preset: saved.preset || defaultPreset.id,
      timeWindow: saved.timeWindow || defaultPreset.timeWindow || "24h",
      activeLayers: saved.activeLayers?.length ? saved.activeLayers : defaultPreset.activeLayers || []
    });
  }

  readSavedState() {
    try {
      const value = window.localStorage.getItem(STORAGE_KEY);
      return value ? JSON.parse(value) : {};
    } catch {
      return {};
    }
  }

  persist() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // ignore storage failures
    }
  }

  subscribe(listener) {
    this.subscribers.add(listener);
    listener(cloneState(this.state));
    return () => this.subscribers.delete(listener);
  }

  emit(previousState) {
    const snapshot = cloneState(this.state);
    this.persist();
    for (const subscriber of this.subscribers) {
      subscriber(snapshot, cloneState(previousState));
    }
  }

  getState() {
    return cloneState(this.state);
  }

  setState(nextState) {
    const previousState = this.state;
    this.state = cloneState({
      ...this.state,
      ...nextState
    });
    this.emit(previousState);
  }

  setEngine(engine) {
    this.setState({ engine: engine || "leaflet" });
  }

  setTimeWindow(timeWindow) {
    this.setState({ timeWindow });
  }

  applyPreset(presetId) {
    const preset = (this.config.presets || []).find((candidate) => candidate.id === presetId);
    if (!preset) {
      return;
    }
    this.setState({
      preset: preset.id,
      activeLayers: preset.activeLayers || [],
      timeWindow: preset.timeWindow || this.state.timeWindow
    });
  }

  toggleLayer(layerId) {
    const active = new Set(this.state.activeLayers);
    if (active.has(layerId)) {
      active.delete(layerId);
    } else {
      active.add(layerId);
    }

    this.setState({
      activeLayers: [...active],
      preset: "Custom"
    });
  }
}
