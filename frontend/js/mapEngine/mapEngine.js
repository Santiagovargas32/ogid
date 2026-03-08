export class BaseMapEngine {
  constructor({ elementId, controlsHost, api, stateStore, themeManager }) {
    this.elementId = elementId;
    this.controlsHost = controlsHost;
    this.api = api;
    this.stateStore = stateStore;
    this.themeManager = themeManager;
    this.latestContext = {
      hotspots: [],
      news: [],
      watchlist: []
    };
  }

  init() {}

  destroy() {}

  renderContext(context = {}) {
    this.latestContext = {
      hotspots: context.hotspots || [],
      news: context.news || [],
      watchlist: context.watchlist || []
    };
  }
}
