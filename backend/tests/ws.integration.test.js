import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { createAppServer } from "../server.js";

function waitForMessage(socket, expectedType, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeListener("message", onMessage);
      reject(new Error(`Timed out waiting for "${expectedType}" message`));
    }, timeoutMs);

    function onMessage(raw) {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === expectedType) {
          clearTimeout(timer);
          socket.removeListener("message", onMessage);
          resolve(message);
        }
      } catch {
        // ignore malformed payload in wait loop
      }
    }

    socket.on("message", onMessage);
  });
}

function closeSocket(socket) {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    socket.once("close", resolve);
    socket.close(1000, "test-complete");
  });
}

test("WebSocket emits snapshot and update envelopes", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const value = String(url);
    if (value.includes("127.0.0.1") || value.includes("localhost")) {
      return originalFetch(url, options);
    }

    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <title>WS Test Feed</title>
          <item>
            <title>Conflict alert in Jerusalem</title>
            <description>Missile defenses remain active.</description>
            <link>https://example.com/ws-test</link>
            <pubDate>${new Date().toUTCString()}</pubDate>
          </item>
        </channel>
      </rss>`,
      {
        status: 200,
        headers: { "content-type": "application/xml" }
      }
    );
  };

  const runtime = createAppServer({
    port: 0,
    disableBackgroundRefresh: true,
    refreshIntervalMs: 300_000,
    wsHeartbeatMs: 60_000,
    market: { provider: "", fallbackProvider: "", refreshIntervalMs: 300_000, requestReserve: 0 },
    news: {
      providers: ["rss"],
      rssFeeds: [{ label: "WS Test Feed", url: "https://example.com/rss.xml" }],
      newsApiKey: "",
      gnewsApiKey: "",
      mediastackApiKey: "",
      timeoutMs: 200
    }
  });

  await runtime.start();
  await runtime.orchestrator.runCycle("test-bootstrap");

  const address = runtime.server.address();
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
    headers: {
      "user-agent": "OGID WS Integration Test/1.0",
      origin: "http://127.0.0.1"
    }
  });

  try {
    const bootstrapPromise = waitForMessage(socket, "market:quotes-bootstrap:v1");
    const snapshotPromise = waitForMessage(socket, "snapshot");

    const bootstrapMessage = await bootstrapPromise;
    assert.equal(bootstrapMessage.type, "market:quotes-bootstrap:v1");
    assert.ok(bootstrapMessage.data.market);
    assert.ok("session" in bootstrapMessage.data.market);

    const snapshotMessage = await snapshotPromise;
    assert.equal(snapshotMessage.type, "snapshot");
    assert.ok(Array.isArray(snapshotMessage.data.hotspots));
    assert.ok(snapshotMessage.data.mapAssets);
    assert.ok(Array.isArray(snapshotMessage.data.mapAssets.staticPoints));
    assert.ok(snapshotMessage.data.meta.dataQuality);
    assert.ok(snapshotMessage.data.meta.refreshStatus);
    assert.ok(snapshotMessage.data.predictions);

    const healthResponse = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    const healthPayload = await healthResponse.json();
    assert.equal(healthResponse.status, 200);
    assert.equal(healthPayload.ok, true);
    assert.equal(healthPayload.data.websocketClients, 1);
    assert.equal(healthPayload.data.websocket.clientCount, 1);
    assert.equal(healthPayload.data.websocket.path, "/ws");
    assert.equal(healthPayload.data.websocket.heartbeatMs, 60_000);
    assert.equal(healthPayload.data.websocket.activeConnections.length, 1);
    assert.equal(healthPayload.data.websocket.lastConnection.clientIp, "127.0.0.1");
    assert.equal(healthPayload.data.websocket.lastConnection.userAgent, "OGID WS Integration Test/1.0");
    assert.equal(healthPayload.data.websocket.lastConnection.origin, "http://127.0.0.1");

    const updatePromise = waitForMessage(socket, "update");
    await runtime.orchestrator.runCycle("test-websocket-update");
    const updateMessage = await updatePromise;

    assert.equal(updateMessage.type, "update");
    assert.ok(Array.isArray(updateMessage.data.news));
    assert.ok(updateMessage.data.mapAssets);
    assert.ok(Array.isArray(updateMessage.data.mapAssets.movingSeeds));
    assert.ok(updateMessage.data.market);
    assert.ok(updateMessage.data.impact);
    assert.ok(updateMessage.data.predictions);
    assert.ok(Array.isArray(updateMessage.data.impactHistory));

    await closeSocket(socket);
    const postCloseHealthResponse = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    const postCloseHealthPayload = await postCloseHealthResponse.json();
    assert.equal(postCloseHealthResponse.status, 200);
    assert.equal(postCloseHealthPayload.data.websocket.clientCount, 0);
    assert.equal(postCloseHealthPayload.data.websocket.lastDisconnection.clientIp, "127.0.0.1");
    assert.equal(postCloseHealthPayload.data.websocket.lastDisconnection.closeCode, 1000);
  } finally {
    global.fetch = originalFetch;
    await closeSocket(socket);
    await runtime.stop();
  }
});
