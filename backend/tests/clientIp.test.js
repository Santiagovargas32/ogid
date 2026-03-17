import test from "node:test";
import assert from "node:assert/strict";
import { normalizeIp, resolveClientIp } from "../utils/clientIp.js";

test("client ip helper normalizes mapped and bracketed addresses", () => {
  assert.equal(normalizeIp("::ffff:127.0.0.1"), "127.0.0.1");
  assert.equal(normalizeIp("[2001:db8::1]:443"), "2001:db8::1");
});

test("client ip helper resolves the socket address and ignores forwarded headers", () => {
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

  const resolved = resolveClientIp(req);

  assert.equal(resolved.clientIp, "127.0.0.1");
  assert.equal(resolved.remoteAddress, "127.0.0.1");
  assert.equal(resolved.expressIp, "127.0.0.1");
});
