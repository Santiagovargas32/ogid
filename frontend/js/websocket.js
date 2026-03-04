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
  }

  setStatus(status) {
    if (typeof this.onStatusChange === "function") {
      this.onStatusChange(status);
    }
  }

  buildUrl() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}${this.path}`;
  }

  connect() {
    this.closedByClient = false;
    this.setStatus("connecting");
    this.socket = new WebSocket(this.buildUrl());

    this.socket.addEventListener("open", () => {
      this.reconnectAttempts = 0;
      this.setStatus("connected");
    });

    this.socket.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (typeof this.onMessage === "function") {
          this.onMessage(payload);
        }
      } catch {
        this.setStatus("error");
      }
    });

    this.socket.addEventListener("close", () => {
      if (this.closedByClient) {
        this.setStatus("disconnected");
        return;
      }

      this.setStatus("reconnecting");
      this.scheduleReconnect();
    });

    this.socket.addEventListener("error", () => {
      this.setStatus("error");
    });
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    const jitter = Math.floor(Math.random() * 200);
    const delay = Math.min(
      this.baseBackoffMs * 2 ** this.reconnectAttempts + jitter,
      this.maxBackoffMs
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  close() {
    this.closedByClient = true;
    clearTimeout(this.reconnectTimer);
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) {
      this.socket.close();
    }
  }
}
