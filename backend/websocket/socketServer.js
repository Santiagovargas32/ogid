import { WebSocket, WebSocketServer } from "ws";
import { normalizeIp, resolveClientIp } from "../utils/clientIp.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("backend/websocket/socketServer");
const MAX_ACTIVE_CONNECTIONS = 5;
const MAX_EVENT_HISTORY = 20;

function createEnvelope(type, data, meta = {}) {
  return JSON.stringify({
    type,
    timestamp: new Date().toISOString(),
    data,
    meta
  });
}

function normalizeHeader(value = "") {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || "").trim()).filter(Boolean).join(", ");
  }

  return String(value || "").trim();
}

function isLoopbackAddress(value = "") {
  const normalized = normalizeIp(value);
  return normalized === "127.0.0.1" || normalized === "::1";
}

function hasForwardingHeaders(request = {}) {
  return ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"].some(
    (name) => Boolean(normalizeHeader(request.headers?.[name]))
  );
}

function isLoopbackHost(host = "", protocol = "http") {
  try {
    const hostname = new URL(`${protocol}://${host}`).hostname;
    return hostname === "localhost" || isLoopbackAddress(hostname);
  } catch {
    return false;
  }
}

function resolveRequestProtocol(request = {}) {
  const forwarded = normalizeHeader(request.headers?.["x-forwarded-proto"])
    .split(",")[0]
    .trim()
    .toLowerCase();
  if (forwarded === "http" || forwarded === "https") {
    return forwarded;
  }
  return request.socket?.encrypted ? "https" : "http";
}

export function validateWebSocketUpgradeOrigin(request = {}) {
  const origin = normalizeHeader(request.headers?.origin);
  const remoteAddress = resolveClientIp(request).remoteAddress;
  const host = normalizeHeader(request.headers?.host);
  const protocol = resolveRequestProtocol(request);
  const directLoopback = isLoopbackAddress(remoteAddress) && isLoopbackHost(host, protocol) && !hasForwardingHeaders(request);
  if (!origin) {
    return {
      allowed: directLoopback,
      reason: directLoopback ? "originless-loopback" : "origin-required"
    };
  }

  if (!host) {
    return { allowed: false, reason: "host-required" };
  }

  try {
    const expectedOrigin = new URL(`${protocol}://${host}`).origin;
    const presentedOrigin = new URL(origin);
    const validProtocol = presentedOrigin.protocol === "http:" || presentedOrigin.protocol === "https:";
    const sameOrigin = validProtocol && presentedOrigin.origin === expectedOrigin;
    if (sameOrigin && isLoopbackAddress(remoteAddress) && !hasForwardingHeaders(request) && !isLoopbackHost(host, protocol)) {
      return { allowed: false, reason: "untrusted-loopback-host" };
    }
    return {
      allowed: sameOrigin,
      reason: sameOrigin ? "same-origin" : "origin-mismatch"
    };
  } catch {
    return { allowed: false, reason: "invalid-origin" };
  }
}

function rejectUpgrade(socket, statusCode = 403, statusText = "Forbidden") {
  if (!socket || socket.destroyed) {
    return;
  }
  socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function buildConnectionInfo(request = {}, path = "/ws") {
  const clientIpInfo = resolveClientIp(request);
  const host = normalizeHeader(request.headers?.host);
  let requestPath = path;

  try {
    requestPath = new URL(request.url || path, `http://${host || "localhost"}`).pathname;
  } catch {
    requestPath = path;
  }

  return {
    clientIp: clientIpInfo.clientIp || null,
    remoteAddress: clientIpInfo.remoteAddress || null,
    expressIp: clientIpInfo.expressIp || null,
    userAgent: normalizeHeader(request.headers?.["user-agent"]) || null,
    origin: normalizeHeader(request.headers?.origin) || null,
    referer: normalizeHeader(request.headers?.referer || request.headers?.referrer) || null,
    host: host || null,
    path: requestPath || path,
    connectedAt: new Date().toISOString()
  };
}

function summarizeConnection(connection = {}) {
  return {
    clientIp: connection.clientIp || null,
    remoteAddress: connection.remoteAddress || null,
    expressIp: connection.expressIp || null,
    userAgent: connection.userAgent || null,
    origin: connection.origin || null,
    referer: connection.referer || null,
    path: connection.path || null,
    connectedAt: connection.connectedAt || null,
    disconnectedAt: connection.disconnectedAt || null,
    closeCode: Number.isFinite(Number(connection.closeCode)) ? Number(connection.closeCode) : null,
    closeReason: connection.closeReason || null
  };
}

function trackEvent(events, type, connection = {}, extra = {}) {
  events.push({
    type,
    timestamp: new Date().toISOString(),
    ...summarizeConnection(connection),
    ...extra
  });

  if (events.length > MAX_EVENT_HISTORY) {
    events.splice(0, events.length - MAX_EVENT_HISTORY);
  }
}

function buildMarketBootstrapPayload(snapshot = {}) {
  const market = snapshot.market || {};
  const quotes = market.quotes || {};
  const orderedTickers = Object.keys(quotes);

  return {
    market: {
      provider: market.provider || "market-router",
      sourceMode: market.sourceMode || "fallback",
      updatedAt: market.updatedAt || null,
      revision: market.revision || null,
      session: market.session || null,
      sourceMeta: {
        provider: market.sourceMeta?.provider || market.provider || "market-router",
        effectiveProvider: market.sourceMeta?.effectiveProvider || market.provider || null,
        providerScore: market.sourceMeta?.providerScore ?? null,
        providerLatencyMs: market.sourceMeta?.providerLatencyMs ?? null,
        marketSession: market.sourceMeta?.marketSession || market.session || null,
        upstreamPaused: market.sourceMeta?.upstreamPaused === true,
        pauseReason: market.sourceMeta?.pauseReason || null
      },
      coverageByMode: market.sourceMeta?.coverageByMode || null,
      quotes: Object.fromEntries(orderedTickers.map((ticker) => [ticker, quotes[ticker]]))
    }
  };
}

export function createSocketServer({ server, path = "/ws", heartbeatMs = 15_000, stateManager }) {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();
  const recentEvents = [];
  const websocketState = {
    lastConnection: null,
    lastDisconnection: null
  };

  server.on("upgrade", (request, socket, head) => {
    let pathname = "";
    try {
      const host = normalizeHeader(request.headers?.host);
      pathname = new URL(request.url, `http://${host || "localhost"}`).pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname !== path) {
      socket.destroy();
      return;
    }

    const connectionInfo = buildConnectionInfo(request, path);
    const originValidation = validateWebSocketUpgradeOrigin(request);
    if (!originValidation.allowed) {
      log.warn("ws_upgrade_rejected", {
        reason: originValidation.reason,
        ...connectionInfo
      });
      rejectUpgrade(socket);
      return;
    }

    request.wsConnectionInfo = connectionInfo;
    wss.handleUpgrade(request, socket, head, (client) => {
      wss.emit("connection", client, request);
    });
  });

  wss.on("connection", (client, request) => {
    client.isAlive = true;
    client.connectionInfo = request?.wsConnectionInfo || buildConnectionInfo(request, path);
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
        log.warn("ws_invalid_message", {
          payload: String(raw).slice(0, 100),
          ...client.connectionInfo
        });
      }
    });

    client.on("close", (closeCode, closeReasonBuffer) => {
      clients.delete(client);
      const closeReason = Buffer.isBuffer(closeReasonBuffer) ? closeReasonBuffer.toString() : String(closeReasonBuffer || "").trim();
      const disconnectedAt = new Date().toISOString();
      const connectionInfo = {
        ...client.connectionInfo,
        disconnectedAt,
        closeCode,
        closeReason: closeReason || null
      };

      websocketState.lastDisconnection = summarizeConnection(connectionInfo);
      trackEvent(recentEvents, "disconnect", connectionInfo, {
        clients: clients.size
      });
      log.info("ws_client_disconnected", {
        clients: clients.size,
        ...connectionInfo
      });
    });

    client.on("error", (error) => {
      log.warn("ws_client_error", {
        message: error.message,
        clients: clients.size,
        ...client.connectionInfo
      });
    });

    const snapshot = stateManager.getSnapshot();
    if (client.readyState === WebSocket.OPEN) {
      client.send(createEnvelope("market:quotes-bootstrap:v1", buildMarketBootstrapPayload(snapshot), snapshot.meta));
      client.send(createEnvelope("snapshot", snapshot, snapshot.meta));
    }

    websocketState.lastConnection = summarizeConnection(client.connectionInfo);
    trackEvent(recentEvents, "connect", client.connectionInfo, {
      clients: clients.size
    });
    log.info("ws_client_connected", {
      clients: clients.size,
      ...client.connectionInfo
    });
  });

  const heartbeatTimer = setInterval(() => {
    for (const client of clients) {
      if (client.isAlive === false) {
        const connectionInfo = {
          ...client.connectionInfo,
          disconnectedAt: new Date().toISOString(),
          closeCode: 1006,
          closeReason: "heartbeat-timeout"
        };
        client.terminate();
        clients.delete(client);
        websocketState.lastDisconnection = summarizeConnection(connectionInfo);
        trackEvent(recentEvents, "disconnect", connectionInfo, {
          clients: clients.size,
          reason: "heartbeat-timeout"
        });
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
    getHealth() {
      return {
        clientCount: clients.size,
        path,
        heartbeatMs,
        activeConnections: Array.from(clients)
          .slice(0, MAX_ACTIVE_CONNECTIONS)
          .map((client) => summarizeConnection(client.connectionInfo)),
        lastConnection: websocketState.lastConnection,
        lastDisconnection: websocketState.lastDisconnection,
        recentEvents: recentEvents.slice(-MAX_EVENT_HISTORY)
      };
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
