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
    socket.close();
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
    market: { refreshIntervalMs: 300_000, apiKey: "", fmpApiKey: "", requestReserve: 0 },
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
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);

  try {
    const snapshotMessage = await waitForMessage(socket, "snapshot");
    assert.equal(snapshotMessage.type, "snapshot");
    assert.ok(Array.isArray(snapshotMessage.data.hotspots));
    assert.ok(snapshotMessage.data.meta.dataQuality);
    assert.ok(snapshotMessage.data.meta.refreshStatus);
    assert.ok(snapshotMessage.data.predictions);

    const updatePromise = waitForMessage(socket, "update");
    await runtime.orchestrator.runCycle("test-websocket-update");
    const updateMessage = await updatePromise;

    assert.equal(updateMessage.type, "update");
    assert.ok(Array.isArray(updateMessage.data.news));
    assert.ok(updateMessage.data.market);
    assert.ok(updateMessage.data.impact);
    assert.ok(updateMessage.data.predictions);
    assert.ok(Array.isArray(updateMessage.data.impactHistory));
  } finally {
    global.fetch = originalFetch;
    await closeSocket(socket);
    await runtime.stop();
  }
});
