// Compatibility projection only. No acquisition, timers, resolver or upstream.
export default class RetiredMediaService {
  start() {}
  stop() {}
  setSocketServer() {}
  getHealth() {
    return {
      status: "retired",
      enabled: false,
      streams: [],
      reason: "MEDIA_RETIRED",
    };
  }
  getAdminSnapshot() {
    return this.getHealth();
  }
  getSnapshot() {
    return { streams: [], health: this.getHealth(), status: "retired" };
  }
}
