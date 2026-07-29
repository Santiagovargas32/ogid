import assert from "node:assert/strict";
import test from "node:test";
import {
  AWARENESS_ALLOWED_HOSTS,
  AWARENESS_SOURCE_CATALOG_VERSION,
  AWARENESS_SOURCES,
  getAwarenessSource
} from "../services/awareness/awarenessCatalog.js";

test("awareness catalog exposes one explicit admission state per unique HTTPS source", () => {
  assert.equal(AWARENESS_SOURCE_CATALOG_VERSION, "1.1.0");
  assert.equal(new Set(AWARENESS_SOURCES.map((source) => source.sourceId)).size, AWARENESS_SOURCES.length);
  for (const source of AWARENESS_SOURCES) {
    assert.equal(["probing", "shadow", "active", "blocked"].includes(source.admissionState), true, source.sourceId);
    assert.equal(source.enabled, ["shadow", "active"].includes(source.admissionState), source.sourceId);
    assert.equal(new URL(source.url).protocol, "https:");
    assert.equal(AWARENESS_ALLOWED_HOSTS.includes(new URL(source.url).hostname), true);
  }
});

test("blocked transports stay blocked while reviewed replacements start no higher than shadow", () => {
  assert.equal(getAwarenessSource("awareness-centcom-releases").admissionState, "blocked");
  assert.equal(getAwarenessSource("awareness-marad-advisories").admissionState, "blocked");
  assert.equal(getAwarenessSource("awareness-idf-releases").admissionState, "blocked");

  const maradRss = getAwarenessSource("awareness-marad-advisories-rss");
  assert.equal(maradRss.admissionState, "probing");
  assert.deepEqual(maradRss.fallbackFor, ["awareness-marad-advisories"]);
  assert.equal(maradRss.coverageRole, "same-publisher-alternate-transport");

  const dvids = getAwarenessSource("awareness-centcom-dvids");
  assert.equal(dvids.admissionState, "shadow");
  assert.equal(dvids.role, "official-distributor");
  assert.deepEqual(dvids.rssItemPathPrefixes, ["/news/"]);
  assert.deepEqual(dvids.rssItemAllowedHosts, ["www.dvidshub.net", "dvidshub.net"]);
  assert.deepEqual(dvids.fallbackFor, ["awareness-centcom-releases"]);

  assert.equal(getAwarenessSource("awareness-us-defense-releases").admissionState, "shadow");
  assert.equal(getAwarenessSource("awareness-ecb-rss").admissionState, "shadow");
  assert.equal(getAwarenessSource("awareness-usgs-significant").emptyResultPolicy, "healthy");
  assert.equal(getAwarenessSource("awareness-usgs-significant").minPollIntervalMs, 5 * 60_000);
});
