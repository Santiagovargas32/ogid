import test from "node:test";
import assert from "node:assert/strict";
import { sensitiveRouteAuth } from "../middleware/sensitiveRouteAuth.js";
import { sanitizeSensitiveData, sanitizeUrl } from "../utils/sanitize.js";

function runAuth({ path = "/api/admin/api-limits", method = "GET", force = "", remoteAddress = "198.51.100.10", token = "", configuredToken = "" } = {}) {
  let nextCalled = false;
  let statusCode = 200;
  let body = null;
  const req = {
    path,
    method,
    query: force ? { force } : {},
    headers: token ? { authorization: `Bearer ${token}` } : {},
    socket: { remoteAddress },
    ip: remoteAddress
  };
  const res = {
    app: { locals: { config: { security: { allowLocalAdmin: true, adminApiToken: configuredToken } } } },
    status(value) { statusCode = value; return this; },
    json(value) { body = value; return this; }
  };
  sensitiveRouteAuth(req, res, () => { nextCalled = true; });
  return { nextCalled, statusCode, body };
}

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

test("sensitive routes deny remote anonymous access and accept configured tokens", () => {
  assert.equal(runAuth().statusCode, 401);
  assert.equal(runAuth({ method: "POST", path: "/intel/refresh" }).statusCode, 401);
  assert.equal(runAuth({ path: "/news/aggregate", force: "1" }).statusCode, 401);
  assert.equal(runAuth({ configuredToken: "test-admin-token", token: "test-admin-token" }).nextCalled, true);
  assert.equal(runAuth({ remoteAddress: "127.0.0.1" }).nextCalled, true);
});
