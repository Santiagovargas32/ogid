import { WebSocket, WebSocketServer } from "ws";
import { createLogger } from "../utils/logger.js";

const log = createLogger("backend/websocket/socketServer");

function createEnvelope(type, data, meta = {}) {
  return JSON.stringify({
    type,
    timestamp: new Date().toISOString(),
    data,
    meta
  });
}

export function createSocketServer({ server, path = "/ws", heartbeatMs = 15_000, stateManager }) {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();

  server.on("upgrade", (request, socket, head) => {
    let pathname = "";
    try {
      pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname !== path) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (client) => {
      wss.emit("connection", client, request);
    });
  });

  wss.on("connection", (client) => {
    client.isAlive = true;
    clients.add(client);

    client.on("pong", () => {
      client.isAlive = true;
    });

    client.on("message", (raw) => {
      try {
        const payload = JSON.parse(raw.toString());
        if (payload?.type === "pong") {
          client.isAlive = true;
        }
      } catch {
        log.warn("ws_invalid_message", { payload: String(raw).slice(0, 100) });
      }
    });

    client.on("close", () => {
      clients.delete(client);
      log.info("ws_client_disconnected", { clients: clients.size });
    });

    client.on("error", (error) => {
      log.warn("ws_client_error", { message: error.message });
    });

    const snapshot = stateManager.getSnapshot();
    if (client.readyState === WebSocket.OPEN) {
      client.send(createEnvelope("snapshot", snapshot, snapshot.meta));
    }

    log.info("ws_client_connected", { clients: clients.size });
  });

  const heartbeatTimer = setInterval(() => {
    for (const client of clients) {
      if (client.isAlive === false) {
        client.terminate();
        clients.delete(client);
        continue;
      }

      client.isAlive = false;
      if (client.readyState === WebSocket.OPEN) {
        client.ping();
        client.send(createEnvelope("heartbeat", { ok: true }, { clients: clients.size }));
      }
    }
  }, heartbeatMs);

  heartbeatTimer.unref?.();

  return {
    broadcast(type, data, meta = {}) {
      const envelope = createEnvelope(type, data, meta);
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(envelope);
        }
      }
    },
    clientCount() {
      return clients.size;
    },
    close() {
      clearInterval(heartbeatTimer);
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.close(1001, "server-shutdown");
        }
      }
      wss.close();
    }
  };
}
