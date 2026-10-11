export class RealtimeSocket {
  constructor({ path = "/ws", onMessage, onStatusChange }) {
    this.path = path;
    this.onMessage = onMessage;
    this.onStatusChange = onStatusChange;
    this.socket = null;
    this.reconnectAttempts = 0;
    this.maxBackoffMs = 15_000;
    this.baseBackoffMs = 750;
    this.reconnectTimer = null;
    this.closedByClient = false;
    this.stableTimer = null;
    this.lastClose = null;
    this.handlePageHide = () => this.close();
    window.addEventListener("pagehide", this.handlePageHide);
  }

  setStatus(status) {
    if (typeof this.onStatusChange === "function") {
      this.onStatusChange(status, this.lastClose);
    }
  }

  buildUrl() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}${this.path}`;
  }

  connect() {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.closedByClient = false;
    this.setStatus("connecting");
    const socket = this.socket = new WebSocket(this.buildUrl());

    socket.addEventListener("open", () => {
      if (this.socket !== socket || this.closedByClient) return;
      // A server repeatedly accepting then closing must still back off.
      this.stableTimer = setTimeout(() => { this.reconnectAttempts = 0; }, 30_000);
      this.setStatus("connected");
    });

    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || this.closedByClient) return;
      try {
        const payload = JSON.parse(event.data);
        if (typeof this.onMessage === "function") {
          this.onMessage(payload);
        }
      } catch {
        this.setStatus("error");
      }
    });

    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
      this.lastClose = { code: event.code, reason: event.reason, wasClean: event.wasClean };
      if (this.closedByClient) {
        this.setStatus("disconnected");
        return;
      }

      if (event.code === 1008) { this.setStatus("error"); return; }
      this.setStatus("reconnecting");
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      if (this.socket !== socket || this.closedByClient) return;
      this.setStatus("error");
    });
  }

  scheduleReconnect() {
    if (this.closedByClient || this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    const ceiling = this.reconnectAttempts >= 20 ? 60_000 : Math.min(this.baseBackoffMs * 2 ** Math.min(6, this.reconnectAttempts), this.maxBackoffMs);
    const delay = Math.round(ceiling * (0.5 + Math.random() * 0.5));
    this.reconnectAttempts = Math.min(20, this.reconnectAttempts + 1);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
  }

  close() {
    this.closedByClient = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.stableTimer);
    this.reconnectTimer = null;
    this.stableTimer = null;
    window.removeEventListener("pagehide", this.handlePageHide);
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) {
      this.socket.close();
    }
  }
}
