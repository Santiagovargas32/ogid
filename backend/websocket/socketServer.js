import {compactError} from './errorEnvelope.js';
import { WebSocket, WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { StateSync } from "./stateSync.js";
import { BoundedTransport, closeBounded, TRANSPORT_DEFAULTS } from "./boundedTransport.js";
export { sendBoundedEnvelope } from "./boundedTransport.js";
import { normalizeIp, resolveClientIp } from "../utils/clientIp.js";
import { createLogger } from "../utils/logger.js";
import { sanitizeSensitiveData } from "../utils/sanitize.js";
import {operationalSummary,DASHBOARD_POLICY} from '../state/dashboardProjection.js';

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
    connectionId: connection.connectionId || null,
    durationMs: Number.isFinite(connection.durationMs) ? connection.durationMs : null,
    requestedCloseCode: connection.requestedCloseCode || null,
    requestedCloseReason: connection.requestedCloseReason || null,
    closeFrameSent: connection.closeFrameSent ?? null,
    closeFrameReceived: connection.closeFrameReceived ?? null,
    anomalous: connection.closeCode === 1006,
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

export function createSocketServer({ server, path = "/ws", heartbeatMs = 15_000, stateManager, transportLimits = {}, trustedProxyIps = [], allowedOrigins = [] }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const clients = new Set();
  const sync = new StateSync(stateManager);
  let pipelineTimer=null,operationalSequence=0,lastPipelineStatus={};
  const publishState=resources=>{
    const change=sync.change(resources);if(!change)return;
    const manifest=sync.manifest();
    const latest={...change,resources:manifest.resources,profiles:manifest.profiles};
    for(const client of clients)send(client,'state:revision:v2',latest,{},'state');
    if(resources.includes('pipelineStatus')){
      const stages=operationalSummary(stateManager.getSyncResource?stateManager.getSyncResource('pipelineStatus'):stateManager.getSnapshot().pipelineStatus);
      let summary={epoch:sync.epoch,sequence:++operationalSequence,stages};
      if(Buffer.byteLength(createEnvelope('pipeline:status:v1',summary))>DASHBOARD_POLICY.operationalBytes)summary={epoch:sync.epoch,sequence:operationalSequence,stages:{},status:'unavailable',reason:'summary-budget-exceeded'};
      for(const client of clients)send(client,'pipeline:status:v1',summary,{},'pipeline');
    }
  };
  const transportSamples = [];
  const recentEvents = [];
  const websocketState = {
    lastConnection: null,
    lastDisconnection: null
  };
  const errorNotices=new Map();
  const metrics = { upgradeRejected: 0, envelopes: 0, bytes: 0, dropped: 0, maxBufferedBytes: 0, heartbeatTimeouts: 0, closeCodes: {} };
  function observe(sample) {
    metrics.maxBufferedBytes = Math.max(metrics.maxBufferedBytes, sample.bufferedBefore || 0, sample.bufferedAfter || 0,sample.bufferedAfterSend || 0);
    if (sample.outcome === "sent") { metrics.envelopes++; metrics.bytes += sample.payloadBytes; }
    else if(["coalesced","temporarily-slow"].includes(sample.outcome)){metrics[sample.outcome]=(metrics[sample.outcome] || 0)+1;}
    else { metrics.dropped++; log.warn("ws_transport_pressure", sample); }
    metrics.byEvent ||= {};
    const event = metrics.byEvent[sample.event] ||= { messages: 0, bytes: 0, maxPayloadBytes: 0, serializationMs: 0 };
    if (sample.outcome === "sent") { event.messages++; event.bytes += sample.payloadBytes; event.maxPayloadBytes = Math.max(event.maxPayloadBytes, sample.payloadBytes); event.serializationMs += sample.serializationMs; }
    transportSamples.push(sample); if (transportSamples.length > 20) transportSamples.shift();
  }
  function send(client, type, data, meta = {}, coalesceKey = null) {
    const started = performance.now();
    if(type==='error')({data,meta}=compactError(data,meta));
    let envelope=createEnvelope(type,data,meta);
    if(type==='error'&&Buffer.byteLength(envelope)>(transportLimits.maxMessageBytes || TRANSPORT_DEFAULTS.maxMessageBytes))
      envelope=createEnvelope('error',{message:'Operation failed',code:data.code,requestId:data.requestId});
    return client.boundedTransport.enqueue(envelope, { event: type, revision: data?.revision ?? sync.revision, coalesceKey, serializationMs: performance.now() - started });
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
    client.connectionId = randomUUID(); client.connectedAtMs = performance.now();
    client.boundedTransport = new BoundedTransport(client, { limits: transportLimits, observe,
      onOversize: (sample) => {
        // A misconfigured budget must not recursively enqueue an oversized recovery frame.
        if (sample.event === "resync:required:v2") closeBounded(client, 1013, "resync-required");
        else send(client, "resync:required:v2", { ...sync.manifest(), reason: "payload-too-large" }, {}, "resync");
      } });
    client.isAlive = true;
    client.missedPongs = 0;
    client.connectionInfo = {...(request?.wsConnectionInfo || buildConnectionInfo(request,path)),connectionId:client.connectionId};
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
        closeReason: sanitizeSensitiveData(closeReason).slice(0, 123) || null,
        connectionId: client.connectionId,
        durationMs: performance.now() - client.connectedAtMs,
        requestedCloseCode: client.runtimeCloseCode || null,
        requestedCloseReason: client.runtimeCloseReason || null,
        closeFrameSent: typeof client._closeFrameSent === "boolean" ? client._closeFrameSent : null,
        closeFrameReceived: typeof client._closeFrameReceived === "boolean" ? client._closeFrameReceived : null,
        anomalous: closeCode === 1006
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

    send(client, "ws:ready:v2", sync.manifest());

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
        send(client, "heartbeat", { ok: true }, { clients: clients.size }, "heartbeat");
      }
    }
  }, heartbeatMs);

  heartbeatTimer.unref?.();

  return {
    sync,
    broadcast(type, data, meta = {}) {
      if (["snapshot", "update", "ai:update:v1", "awareness:update:v1"].includes(type)) {
        const resources = type === "awareness:update:v1" ? ["awareness"] : type === "ai:update:v1" ? ["ai"] : Object.keys(data || {});
        if(resources.length===1 && resources[0]==='pipelineStatus'){
          const stages=data.pipelineStatus || {};
          const urgent=Object.entries(stages).some(([id,stage])=>stage.status!==lastPipelineStatus[id] &&
            (['failed','blocked','degraded'].includes(stage.status)||['failed','blocked','degraded'].includes(lastPipelineStatus[id])));
          lastPipelineStatus=Object.fromEntries(Object.entries(stages).map(([id,stage])=>[id,stage.status]));
          if(urgent){clearTimeout(pipelineTimer);pipelineTimer=null;publishState(resources);}
          else if(!pipelineTimer){pipelineTimer=setTimeout(()=>{pipelineTimer=null;publishState(resources);},1000);pipelineTimer.unref?.();}
        }else publishState(resources);
        return;
      }
      let coalesceKey=null;
      if(type==='error'&&data?.recoverable){
        const key=`${meta.domain || data.domain || 'system'}:${data.code}`;
        const previous=errorNotices.get(key),now=Date.now();
        if(previous&&now-previous.at<1000){previous.count++;metrics.suppressedErrorNotices=(metrics.suppressedErrorNotices || 0)+1;return;}
        if(errorNotices.size>=32)errorNotices.delete(errorNotices.keys().next().value);
        errorNotices.set(key,{at:now,count:(previous?.count || 0)+1});coalesceKey=`error:${key}`;
      }
      for (const client of clients) send(client, type, data, meta,coalesceKey);
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
        synchronization: { ...sync.manifest(), metrics: { ...sync.metrics } },
        transportLimits: { ...TRANSPORT_DEFAULTS, ...transportLimits },
        transportSamples: transportSamples.slice(),
        pendingMessages: [...clients].reduce((n,c) => n + c.boundedTransport.queue.length, 0),
        activeConnections: Array.from(clients)
          .slice(0, MAX_ACTIVE_CONNECTIONS)
          .map((client) => summarizeConnection({...client.connectionInfo,durationMs:performance.now()-client.connectedAtMs})),
        lastConnection: websocketState.lastConnection,
        lastDisconnection: websocketState.lastDisconnection,
        recentEvents: recentEvents.slice(-MAX_EVENT_HISTORY)
      };
    },
    close() {
      clearTimeout(pipelineTimer);
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
