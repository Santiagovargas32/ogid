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

test("admin routes and mutations allow loopback and LAN peers by default", async (t) => {
  const runtime = createAppServer({
    port: 0,
    host: "127.0.0.1",
    disableBackgroundRefresh: true,
    news: { providers: [], rssFeeds: [] },
    market: { provider: "", historyPersist: false },
    security: { adminApiToken: "fixture-admin-token", allowLocalAdmin: true }
  });
  // Simulate the peer address before Express handles real HTTP requests.
  let remoteAddress = "127.0.0.1";
  runtime.server.prependListener("request", (req) => {
    Object.defineProperty(req.socket, "remoteAddress", { configurable: true, value: remoteAddress });
  });
  t.after(() => runtime.stop());
  await runtime.start();
  const baseUrl = `http://127.0.0.1:${runtime.server.address().port}`;
  for (const [address, allowed] of [
    ["127.0.0.1", true], ["::1", true], ["::ffff:127.0.0.1", true],
    ["192.168.1.48", true], ["::ffff:192.168.1.48", true],
    ["10.0.0.42", true], ["172.16.0.42", true], ["172.31.255.254", true],
    ["169.254.1.42", true], ["fc00::42", true], ["fd00::42", true],
    ["fe80::42%eth0", true], ["febf::42", true],
    ["172.15.255.254", false], ["172.32.0.42", false], ["192.169.1.42", false],
    ["203.0.113.42", false], ["2001:db8::42", false],
    ["fc::42", false], ["fe7f::42", false], ["fec0::42", false]
  ]) {
    remoteAddress = address;
    const headers = { authorization: "Bearer fixture-admin-token" };
    for (const path of ["/admin", "/admin/"]) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, allowed ? 200 : 401, `${address} ${path}`);
      const authorized = await fetch(`${baseUrl}${path}`, { headers });
      assert.equal(authorized.status, 200);
      assert.match(await authorized.text(), /<html/);
    }
    for (const path of ["/api/admin/api-limits", "/api/admin/news-raw", "/api/admin/pipeline-status", "/api/admin/ai-enrichments"]) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, allowed ? 200 : 401, `${address} ${path}`);
      const authorized = await fetch(`${baseUrl}${path}`, { headers });
      assert.equal(authorized.status, 200);
      assert.equal((await authorized.json()).ok, true);
    }
    const forced = await fetch(`${baseUrl}/api/market/candles?force=1&instrumentId=unknown`);
    assert.equal(forced.status, allowed ? 400 : 401, address);
    assert.equal((await forced.json()).error.code, allowed ? "INVALID_INSTRUMENT" : "ADMIN_AUTH_REQUIRED");
    const authorizedForce = await fetch(`${baseUrl}/api/market/candles?force=1&instrumentId=unknown`, { headers });
    assert.equal(authorizedForce.status, 400);
    assert.equal((await authorizedForce.json()).error.code, "INVALID_INSTRUMENT");
    const backfill = await fetch(`${baseUrl}/api/market/candles/backfill`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}"
    });
    assert.equal(backfill.status, allowed ? 400 : 401, address);
    assert.equal((await backfill.json()).error.code, allowed ? "INVALID_INSTRUMENTS" : "ADMIN_AUTH_REQUIRED");
    const authorizedBackfill = await fetch(`${baseUrl}/api/market/candles/backfill`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}"
    });
    assert.equal(authorizedBackfill.status, 400);
    assert.equal((await authorizedBackfill.json()).error.code, "INVALID_INSTRUMENTS");
  }
  remoteAddress = "203.0.113.42";
  const spoofed = await fetch(`${baseUrl}/api/admin/api-limits`, {
    headers: { "x-forwarded-for": "192.168.1.48", "x-real-ip": "127.0.0.1", forwarded: "for=10.0.0.42" }
  });
  assert.equal(spoofed.status, 401);
  remoteAddress = "192.168.1.48";
  runtime.app.locals.config.security.adminApiToken = "";
  assert.equal((await fetch(`${baseUrl}/admin`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/admin/api-limits`)).status, 200);
  runtime.app.locals.config.security.adminApiToken = "fixture-admin-token";
  runtime.app.locals.config.security.allowLanAdmin = false;
  assert.equal((await fetch(`${baseUrl}/admin`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/admin/api-limits`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/admin/api-limits`, { headers: { "x-admin-token": "fixture-admin-token" } })).status, 200);
  remoteAddress = "127.0.0.1";
  assert.equal((await fetch(`${baseUrl}/api/admin/api-limits`)).status, 200);
  runtime.app.locals.config.security.allowLocalAdmin = false;
  assert.equal((await fetch(`${baseUrl}/api/admin/api-limits`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/admin/api-limits`, { headers: { authorization: "Bearer invalid" } })).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/admin/api-limits`, { headers: { "x-admin-token": "fixture-admin-token" } })).status, 200);
});
