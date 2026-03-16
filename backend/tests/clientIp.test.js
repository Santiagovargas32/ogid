import test from "node:test";
import assert from "node:assert/strict";
import { compileIpAllowlist, normalizeIp, parseTrustProxySetting, resolveClientIp } from "../utils/clientIp.js";

test("client ip helper normalizes mapped and bracketed addresses", () => {
  assert.equal(normalizeIp("::ffff:127.0.0.1"), "127.0.0.1");
  assert.equal(normalizeIp("[2001:db8::1]:443"), "2001:db8::1");
});

test("client ip helper resolves forwarded headers only when trust proxy is enabled", () => {
  const req = {
    headers: {
      "x-forwarded-for": "198.51.100.20, 10.0.0.10",
      "x-real-ip": "198.51.100.21"
    },
    socket: {
      remoteAddress: "::ffff:127.0.0.1"
    },
    ip: "::ffff:127.0.0.1"
  };

  const withoutProxy = resolveClientIp(req, { trustProxy: false });
  const withProxy = resolveClientIp(req, { trustProxy: true });

  assert.equal(withoutProxy.clientIp, "127.0.0.1");
  assert.equal(withProxy.clientIp, "198.51.100.20");
  assert.deepEqual(withProxy.forwardedFor, ["198.51.100.20", "10.0.0.10"]);
});

test("client ip helper compiles exact and cidr allowlists", () => {
  const allowlist = compileIpAllowlist(["127.0.0.1/32", "2001:db8::/32"]);

  assert.equal(allowlist.enabled, true);
  assert.equal(allowlist.isAllowed("127.0.0.1"), true);
  assert.equal(allowlist.isAllowed("127.0.0.2"), false);
  assert.equal(allowlist.isAllowed("2001:db8::25"), true);
  assert.equal(allowlist.isAllowed("2001:db9::25"), false);
});

test("client ip helper parses trust proxy variants", () => {
  assert.equal(parseTrustProxySetting("true", false), true);
  assert.equal(parseTrustProxySetting("2", false), 2);
  assert.deepEqual(parseTrustProxySetting("loopback, linklocal", false), ["loopback", "linklocal"]);
});
