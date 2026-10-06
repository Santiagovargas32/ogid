import test from "node:test";
import assert from "node:assert/strict";
import { createAppServer } from "../server.js";
import { sanitizeSensitiveData, sanitizeUrl } from "../utils/sanitize.js";

test("sensitive URL values and nested tokens are redacted", () => {
  const rawUrl = "https://example.test/data?apiKey=do-not-log&token=also-secret&crumb=crumb-secret&cookie=cookie-secret&symbol=GD";
  const sanitized = sanitizeUrl(rawUrl);
  assert.equal(sanitized.includes("do-not-log"), false);
  assert.equal(sanitized.includes("also-secret"), false);
  assert.equal(sanitized.includes("crumb-secret"), false);
  assert.equal(sanitized.includes("cookie-secret"), false);
  assert.equal(new URL(sanitized).searchParams.get("symbol"), "GD");
  assert.equal(sanitizeSensitiveData({ authorization: "Bearer secret", cookie: "session-secret", nested: { apiKey: "secret" } }).nested.apiKey, "***");
  const message = sanitizeSensitiveData("Retrieved crumb from cookie store: message-secret\nCookie: A3=header-secret; A1=second-secret; GUC=third-secret");
  assert.equal(message.includes("message-secret"), false);
  assert.equal(message.includes("header-secret"), false);
  assert.equal(message.includes("second-secret"), false);
  assert.equal(message.includes("third-secret"), false);
});

test("admin routes and mutations require no token on loopback or LAN", async (t) => {
  const runtime = createAppServer({
    port: 0,
    host: "127.0.0.1",
    disableBackgroundRefresh: true,
    news: { providers: [], rssFeeds: [] },
    market: { provider: "", historyPersist: false }
  });
  // Simulate the peer address before Express handles real HTTP requests.
  let remoteAddress = "127.0.0.1";
  runtime.server.prependListener("request", (req) => {
    Object.defineProperty(req.socket, "remoteAddress", { configurable: true, value: remoteAddress });
  });
  t.after(() => runtime.stop());
  await runtime.start();
  const baseUrl = `http://127.0.0.1:${runtime.server.address().port}`;
  for (const address of ["127.0.0.1", "192.168.1.42", "::ffff:192.168.1.42", "fd00::42"]) {
    remoteAddress = address;
    for (const path of ["/admin", "/admin/", "/admin.html"]) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 200, `${address} ${path}`);
      assert.match(response.headers.get("content-type"), /text\/html/);
      assert.match(await response.text(), /<html/);
    }
    for (const path of ["/api/admin/api-limits", "/api/admin/news-raw", "/api/admin/pipeline-status", "/api/admin/ai-enrichments"]) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 200, `${address} ${path}`);
      assert.equal((await response.json()).ok, true);
    }
    const forced = await fetch(`${baseUrl}/api/market/candles?force=1&instrumentId=unknown`);
    assert.equal(forced.status, 400);
    assert.equal((await forced.json()).error.code, "INVALID_INSTRUMENT");
    const backfill = await fetch(`${baseUrl}/api/market/candles/backfill`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}"
    });
    assert.equal(backfill.status, 400);
    assert.equal((await backfill.json()).error.code, "INVALID_INSTRUMENTS");
  }
});
