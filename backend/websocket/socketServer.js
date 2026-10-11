import { WebSocket, WebSocketServer } from "ws";
import { normalizeIp, resolveClientIp } from "../utils/clientIp.js";
import { createLogger } from "../utils/logger.js";
import { sanitizeSensitiveData } from "../utils/sanitize.js";

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

function closeBounded(client, code, reason) {
  if (client.runtimeCloseReason) return;
  client.runtimeCloseReason = reason;
  client.close(code, reason);
  // Give the close frame a chance to reach the peer; bound a stalled TCP close.
  const timer = setTimeout(() => client.terminate(), 1_000);
  timer.unref?.();
  client.once("close", () => clearTimeout(timer));
}

export function sendBoundedEnvelope(client, envelope) {
  if (client.readyState !== WebSocket.OPEN || client.runtimeCloseReason) return false;
  if (client.bufferedAmount + Buffer.byteLength(envelope) > 1_000_000) {
    closeBounded(client, 1013, "resync-required");
    return false;
  }
  try {
    client.send(envelope, error => { if (error) closeBounded(client, 1011, "send-failed"); });
    return true;
  } catch {
    closeBounded(client, 1011, "send-failed");
    return false;
  }
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

export function validateWebSocketUpgradeOrigin(request = {}, { trustedProxyIps = [], allowedOrigins = [] } = {}) {
  const origin = normalizeHeader(request.headers?.origin);
  const remoteAddress = resolveClientIp(request).remoteAddress;
  let host = normalizeHeader(request.headers?.host);
  let protocol = request.socket?.encrypted ? "https" : "http";
  const trustedProxy = trustedProxyIps.some(ip => normalizeIp(ip) === remoteAddress && remoteAddress);
  if (trustedProxy && hasForwardingHeaders(request)) {
    // One trusted reverse proxy must overwrite these headers, never append a chain.
    const forwarded = normalizeHeader(request.headers?.forwarded);
    const proxyHost = normalizeHeader(request.headers?.["x-forwarded-host"]) || forwarded.match(/(?:^|;)\s*host="?([^";,\s]+)"?/i)?.[1];
    const proxyProtocol = normalizeHeader(request.headers?.["x-forwarded-proto"]) || forwarded.match(/(?:^|;)\s*proto="?(https?)"?(?:;|$)/i)?.[1];
    if (forwarded.includes(",") || !proxyHost || !["http", "https"].includes(proxyProtocol)) {
      return { allowed: false, reason: "invalid-proxy-headers" };
    }
    host = proxyHost;
    protocol = proxyProtocol;
  }
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
    const expected = new URL(`${protocol}://${host}`);
    if (expected.username || expected.password || expected.pathname !== "/" || expected.search || expected.hash || host.includes(",")) {
      return { allowed: false, reason: "invalid-host" };
    }
    const expectedOrigin = expected.origin;
    const presentedOrigin = new URL(origin);
    const validProtocol = presentedOrigin.protocol === "http:" || presentedOrigin.protocol === "https:";
    const strictOrigin = validProtocol && !presentedOrigin.username && !presentedOrigin.password && presentedOrigin.pathname === "/" && !presentedOrigin.search && !presentedOrigin.hash;
    const sameOrigin = strictOrigin && presentedOrigin.origin === expectedOrigin;
    const explicitlyAllowed = allowedOrigins.includes(expectedOrigin);
    const directLocalHost = normalizeIp(new URL(expectedOrigin).hostname) === normalizeIp(request.socket?.localAddress) && normalizeIp(request.socket?.localAddress);
    if (sameOrigin && isLoopbackAddress(remoteAddress) && !trustedProxy && !isLoopbackHost(host, protocol) && !explicitlyAllowed && !directLocalHost) {
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
    userAgent: sanitizeSensitiveData(normalizeHeader(request.headers?.["user-agent"])).slice(0, 240) || null,
    origin: safeOrigin(request.headers?.origin),
    host: safeOrigin(`http://${host}`),
    path: requestPath || path,
    connectedAt: new Date().toISOString()
  };
}

function safeOrigin(value) {
  try { return new URL(normalizeHeader(value)).origin; } catch { return null; }
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

export function createSocketServer({ server, path = "/ws", heartbeatMs = 15_000, stateManager, trustedProxyIps = [], allowedOrigins = [] }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const clients = new Set();
  const recentEvents = [];
  const websocketState = {
    lastConnection: null,
    lastDisconnection: null
  };
  const metrics = { upgradeRejected: 0, envelopes: 0, bytes: 0, dropped: 0, maxBufferedBytes: 0, heartbeatTimeouts: 0, closeCodes: {} };
  function send(client, envelope) {
    metrics.maxBufferedBytes = Math.max(metrics.maxBufferedBytes, client.bufferedAmount);
    if (sendBoundedEnvelope(client, envelope)) { metrics.envelopes++; metrics.bytes += Buffer.byteLength(envelope); }
    else metrics.dropped++;
  }

  const handleUpgrade = (request, socket, head) => {
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
    const originValidation = validateWebSocketUpgradeOrigin(request, { trustedProxyIps, allowedOrigins });
    if (!originValidation.allowed) {
      metrics.upgradeRejected++;
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
  };
  server.on("upgrade", handleUpgrade);

  wss.on("connection", (client, request) => {
    client.isAlive = true;
    client.missedPongs = 0;
    client.connectionInfo = request?.wsConnectionInfo || buildConnectionInfo(request, path);
    clients.add(client);

    client.on("pong", () => {
      client.isAlive = true;
      client.missedPongs = 0;
    });

    client.on("message", (raw) => {
      try {
        const payload = JSON.parse(raw.toString());
        if (payload?.type === "pong") {
          client.isAlive = true;
          client.missedPongs = 0;
        }
      } catch {
        log.warn("ws_invalid_message", {
          ...client.connectionInfo
        });
      }
    });

    client.on("close", (closeCode, closeReasonBuffer) => {
      clients.delete(client);
      metrics.closeCodes[closeCode] = (metrics.closeCodes[closeCode] || 0) + 1;
      const closeReason = Buffer.isBuffer(closeReasonBuffer) ? closeReasonBuffer.toString() : String(closeReasonBuffer || "").trim();
      const disconnectedAt = new Date().toISOString();
      const connectionInfo = {
        ...client.connectionInfo,
        disconnectedAt,
        closeCode,
        closeReason: client.runtimeCloseReason || sanitizeSensitiveData(closeReason).slice(0, 123) || null
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
      send(client, createEnvelope("market:quotes-bootstrap:v1", buildMarketBootstrapPayload(snapshot), snapshot.meta));
      send(client, createEnvelope("snapshot", snapshot, snapshot.meta));
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

  let lastHeartbeatAt = performance.now();
  const heartbeatTimer = setInterval(() => {
    const now = performance.now();
    const delayed = now - lastHeartbeatAt > heartbeatMs * 1.5;
    lastHeartbeatAt = now;
    for (const client of clients) {
      if (client.readyState !== WebSocket.OPEN || client.runtimeCloseReason) continue;
      if (!client.isAlive && !delayed) client.missedPongs++;
      if (client.missedPongs >= 2) {
        metrics.heartbeatTimeouts++;
        closeBounded(client, 1001, "heartbeat-timeout");
        continue;
      }

      client.isAlive = false;
      if (client.readyState === WebSocket.OPEN) {
        client.ping();
        send(client, createEnvelope("heartbeat", { ok: true }, { clients: clients.size }));
      }
    }
  }, heartbeatMs);

  heartbeatTimer.unref?.();

  return {
    broadcast(type, data, meta = {}) {
      if (!clients.size) return;
      const envelope = createEnvelope(type, data, meta);
      for (const client of clients) {
        send(client, envelope);
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
        metrics: { ...metrics, closeCodes: { ...metrics.closeCodes } },
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
      server.removeListener("upgrade", handleUpgrade);
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          closeBounded(client, 1001, "server-shutdown");
        }
      }
      return new Promise(resolve => wss.close(resolve));
    }
  };
}
