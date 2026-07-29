import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseAwarenessLabCliArgs,
  probeAwarenessSource,
  readRuntimeBlockedSourceIds,
  resolveAwarenessLabUserAgent,
  runAwarenessAdmissionLab,
  selectAwarenessLabSources,
  writeAwarenessLabReports
} from "../scripts/awareness-admission-lab.js";

function rssSource(overrides = {}) {
  return {
    sourceId: "awareness-fixture-rss",
    name: "Fixture Official Releases",
    url: "https://official.example.test/releases.xml",
    hostname: "official.example.test",
    adapter: "rss",
    kind: "macro_release",
    domains: ["financial", "macro"],
    timezone: "UTC",
    admissionState: "probing",
    enabled: false,
    ...overrides
  };
}

function rssFixture(secret = "not-exported") {
  return `<?xml version="1.0"?><rss><channel><item>
    <title>Official policy decision released</title>
    <link>https://official.example.test/releases/decision</link>
    <description>Official release payload marker ${secret}</description>
    <pubDate>Wed, 29 Jul 2026 16:00:00 GMT</pubDate>
  </item></channel></rss>`;
}

test("awareness admission lab requires an explicit bounded selection or all probing", () => {
  const catalog = [
    { sourceId: "source-probing", admissionState: "probing" },
    { sourceId: "source-shadow", admissionState: "shadow" },
    { sourceId: "legacy-pending", enabled: false, disabledReason: "pending-source-promotion" },
    { sourceId: "source-blocked", admissionState: "blocked" }
  ];

  assert.throws(
    () => selectAwarenessLabSources({ sourceIds: ["source-blocked"], catalog }),
    (error) => error.code === "AWARENESS_LAB_SOURCE_BLOCKED"
  );
  assert.throws(
    () => selectAwarenessLabSources({ sourceIds: ["source-shadow"], catalog, runtimeBlockedSourceIds: new Set(["source-shadow"]) }),
    (error) => error.code === "AWARENESS_LAB_SOURCE_RUNTIME_BLOCKED"
  );
  assert.deepEqual(
    selectAwarenessLabSources({ allProbing: true, catalog }).map((source) => source.sourceId),
    ["source-probing", "legacy-pending"]
  );
  assert.throws(
    () => selectAwarenessLabSources({ sourceIds: ["source-probing"], allProbing: true, catalog }),
    (error) => error.code === "AWARENESS_LAB_SELECTION_CONFLICT"
  );
  assert.throws(
    () => selectAwarenessLabSources({ catalog }),
    (error) => error.code === "AWARENESS_LAB_SOURCES_REQUIRED"
  );
  assert.throws(
    () => selectAwarenessLabSources({ sourceIds: ["source-with-?token=secret"], catalog }),
    (error) => error.code === "AWARENESS_LAB_INVALID_SOURCE_ID"
  );
  assert.throws(
    () => selectAwarenessLabSources({
      allProbing: true,
      catalog: Array.from({ length: 11 }, (_, index) => ({ sourceId: `source-${index}`, admissionState: "probing" }))
    }),
    (error) => error.code === "AWARENESS_LAB_TOO_MANY_SOURCES"
  );
});

test("awareness admission lab honors persistent runtime blocks without writing state", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ogid-awareness-runtime-block-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshotPath = path.join(root, "awareness-events.json");
  await writeFile(snapshotPath, JSON.stringify({
    schemaVersion: "awareness-v1",
    sourceStatus: [
      { sourceId: "runtime-blocked", admissionState: "blocked", runtimeBlocked: true, blockedReason: "persistent-http-403" },
      { sourceId: "catalog-active", admissionState: "active", runtimeBlocked: false }
    ]
  }), "utf8");
  const blocked = await readRuntimeBlockedSourceIds({ snapshotPath });
  assert.deepEqual([...blocked], ["runtime-blocked"]);
  assert.equal((await readFile(snapshotPath, "utf8")).includes("runtime-blocked"), true);

  const envFilePath = path.join(root, ".env");
  await writeFile(envFilePath, `SECRET_VALUE=must-not-export\nAWARENESS_STATE_FILE=${snapshotPath.replaceAll("\\", "/")}\n`, "utf8");
  const configuredBlocked = await readRuntimeBlockedSourceIds({ env: {}, envFilePath });
  assert.deepEqual([...configuredBlocked], ["runtime-blocked"]);
  assert.equal(process.env.SECRET_VALUE, undefined);
  const configuredUserAgent = await resolveAwarenessLabUserAgent({ env: {}, envFilePath });
  assert.equal(configuredUserAgent, "OGID-awareness-admission-lab/1.0 (+https://localhost; contact: local-operator)");
});

test("awareness admission lab parses repeatable explicit IDs without accepting ambiguous options", () => {
  const options = parseAwarenessLabCliArgs([
    "--source=awareness-one",
    "--sources=awareness-two,awareness-one",
    "--timeout-ms=5000",
    "--max-bytes=500000",
    "--output-prefix=fixture-awareness-lab"
  ]);
  assert.deepEqual(options.sourceIds, ["awareness-one", "awareness-two"]);
  assert.equal(options.timeoutMs, 5_000);
  assert.equal(options.maxResponseBytes, 500_000);
  assert.equal(options.outputPrefix, "fixture-awareness-lab");
  assert.throws(
    () => parseAwarenessLabCliArgs(["--all-probing=true"]),
    (error) => error.code === "AWARENESS_LAB_UNKNOWN_ARGUMENT"
  );
  assert.throws(
    () => parseAwarenessLabCliArgs(["--output-prefix=../escape"]),
    (error) => error.code === "AWARENESS_LAB_INVALID_OUTPUT_PREFIX"
  );
});

test("awareness lab uses the production user-agent contract and strips header injection", async () => {
  const userAgent = await resolveAwarenessLabUserAgent({
    env: { AWARENESS_USER_AGENT: "OGID/2.0\r\nAuthorization: injected" },
    envFilePath: "unused"
  });
  assert.equal(userAgent, "OGID/2.0 Authorization: injected");
  let observedUserAgent = null;
  await probeAwarenessSource(rssSource(), {
    userAgent,
    fetchImpl: async (_url, options) => {
      observedUserAgent = options.headers["User-Agent"];
      return new Response(rssFixture(), { status: 200, headers: { "content-type": "application/rss+xml" } });
    }
  });
  assert.equal(observedUserAgent, "OGID/2.0 Authorization: injected");
  assert.doesNotMatch(observedUserAgent, /[\r\n]/);
});

test("awareness admission probe returns only sanitized metadata and can recommend at most shadow", async () => {
  const secret = "token=super-secret-payload";
  const body = rssFixture(secret);
  const calls = [];
  const result = await probeAwarenessSource(rssSource(), {
    nowMs: Date.parse("2026-07-29T17:00:00.000Z"),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "application/rss+xml; charset=utf-8",
          "x-request-id": "request-fixture-123",
          "set-cookie": "session=must-not-leak; Secure"
        }
      });
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[0].options.headers.Cookie, undefined);
  assert.equal(result.probeResult, "candidate-for-shadow");
  assert.equal(result.recommendation.maximumState, "shadow");
  assert.equal(result.recommendation.automaticPromotion, false);
  assert.equal(result.responseRequestId, "request-fixture-123");
  assert.equal(result.responseHeaders["set-cookie"], undefined);
  assert.equal(result.bodyBytes, Buffer.byteLength(body));
  assert.equal(result.bodySha256, createHash("sha256").update(body).digest("hex"));
  assert.equal(result.quality.parsedEvents, 1);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("must-not-leak"), false);
  assert.equal(serialized.includes("Official policy decision released"), false);
});

test("an explicitly empty-valid structured source can enter shadow without manufacturing events", async () => {
  const source = rssSource({ emptyResultPolicy: "healthy" });
  const result = await probeAwarenessSource(source, {
    fetchImpl: async () => new Response("<?xml version=\"1.0\"?><rss><channel></channel></rss>", {
      status: 200,
      headers: { "content-type": "application/rss+xml" }
    })
  });
  assert.equal(result.quality.parsedEvents, 0);
  assert.equal(result.probeResult, "candidate-for-shadow");
  assert.equal(result.recommendation.maximumState, "shadow");
});

test("an XML-labelled challenge cannot become a shadow candidate", async () => {
  const result = await probeAwarenessSource(rssSource({ emptyResultPolicy: "healthy" }), {
    fetchImpl: async () => new Response("<html><body><item>Access denied</item></body></html>", {
      status: 200,
      headers: { "content-type": "application/xml" }
    })
  });
  assert.equal(result.errorCode, "AWARENESS_LAB_PARSER_FAILED");
  assert.equal(result.probeResult, "rejected-structure");
  assert.notEqual(result.recommendation.maximumState, "shadow");
});

test("awareness admission lab executes sources sequentially with no retries or persistence", async () => {
  let active = 0;
  let maximumActive = 0;
  const calls = [];
  const sources = [
    rssSource({ sourceId: "awareness-one", url: "https://one.example.test/releases.xml", hostname: "one.example.test" }),
    rssSource({ sourceId: "awareness-two", url: "https://two.example.test/releases.xml", hostname: "two.example.test" })
  ];
  const report = await runAwarenessAdmissionLab({
    sources,
    nowMs: Date.parse("2026-07-29T17:00:00.000Z"),
    fetchImpl: async (url) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      calls.push(String(url));
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return new Response(rssFixture(), { status: 200, headers: { "content-type": "application/xml" } });
    }
  });

  assert.equal(calls.length, 2);
  assert.equal(maximumActive, 1);
  assert.equal(report.requestPolicy.concurrency, 1);
  assert.equal(report.requestPolicy.retries, 0);
  assert.equal(report.requestPolicy.persistence, false);
  assert.equal(report.requestPolicy.publication, false);
  assert.equal(report.summary.logicalAttempts, 2);
  assert.equal(report.summary.automaticPromotions, 0);
  assert.deepEqual(report.sources.map((source) => source.probeResult), ["candidate-for-shadow", "candidate-for-shadow"]);
  assert.equal(report.sources.some((source) => source.probeResult === "active"), false);
});

test("awareness admission probe blocks cross-host redirects and enforces the response cap", async () => {
  let redirectCalls = 0;
  const redirectResult = await probeAwarenessSource(rssSource(), {
    fetchImpl: async () => {
      redirectCalls += 1;
      return new Response(null, {
        status: 302,
        headers: { location: "https://unlisted.example.test/releases.xml" }
      });
    }
  });
  assert.equal(redirectCalls, 1);
  assert.equal(redirectResult.errorCode, "AWARENESS_LAB_HOST_BLOCKED");
  assert.equal(redirectResult.probeResult, "probe-failed");

  const oversizedResult = await probeAwarenessSource(rssSource(), {
    maxResponseBytes: 1_024,
    fetchImpl: async () => new Response("ignored", {
      status: 200,
      headers: { "content-type": "application/xml", "content-length": "4096" }
    })
  });
  assert.equal(oversizedResult.errorCode, "AWARENESS_LAB_RESPONSE_TOO_LARGE");
  assert.equal(oversizedResult.probeResult, "rejected-size-limit");
  assert.equal(oversizedResult.bodySha256, null);
});

test("awareness admission probe permits only allowlisted HTTPS redirects and enforces timeout", async () => {
  const redirectUrls = [];
  const redirectedResult = await probeAwarenessSource(rssSource(), {
    fetchImpl: async (url) => {
      redirectUrls.push(String(url));
      if (new URL(url).pathname === "/releases.xml") {
        return new Response(null, { status: 302, headers: { location: "/final.xml" } });
      }
      return new Response(rssFixture(), { status: 200, headers: { "content-type": "application/xml" } });
    }
  });
  assert.deepEqual(redirectUrls, [
    "https://official.example.test/releases.xml",
    "https://official.example.test/final.xml"
  ]);
  assert.equal(redirectedResult.logicalAttempts, 1);
  assert.equal(redirectedResult.networkRequests, 2);
  assert.equal(redirectedResult.redirectCount, 1);
  assert.equal(redirectedResult.retries, 0);
  assert.equal(redirectedResult.probeResult, "candidate-for-shadow");

  let unsafeCalls = 0;
  const unsafeResult = await probeAwarenessSource(rssSource({
    url: "http://official.example.test/releases.xml"
  }), {
    fetchImpl: async () => {
      unsafeCalls += 1;
      return new Response(rssFixture());
    }
  });
  assert.equal(unsafeCalls, 0);
  assert.equal(unsafeResult.networkRequests, 0);
  assert.equal(unsafeResult.errorCode, "AWARENESS_LAB_UNSAFE_URL");

  const timeoutResult = await probeAwarenessSource(rssSource(), {
    timeoutMs: 10,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("fixture secret must not be reported");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    })
  });
  assert.equal(timeoutResult.networkRequests, 1);
  assert.equal(timeoutResult.errorCode, "AWARENESS_LAB_TIMEOUT");
  assert.equal(timeoutResult.probeResult, "transient-timeout");
  assert.equal(JSON.stringify(timeoutResult).includes("fixture secret"), false);
});

test("awareness admission reports write JSON and Markdown without payloads or cookies", async (t) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "ogid-awareness-lab-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const body = rssFixture("password=body-secret");
  const report = await runAwarenessAdmissionLab({
    sources: [rssSource()],
    nowMs: Date.parse("2026-07-29T17:00:00.000Z"),
    fetchImpl: async () => new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/rss+xml",
        "set-cookie": "credential=header-secret"
      }
    })
  });
  const outputs = await writeAwarenessLabReports(report, { outputDir, outputPrefix: "fixture" });
  const json = await readFile(outputs.jsonPath, "utf8");
  const markdown = await readFile(outputs.markdownPath, "utf8");
  for (const output of [json, markdown]) {
    assert.equal(output.includes("body-secret"), false);
    assert.equal(output.includes("header-secret"), false);
    assert.equal(output.includes("set-cookie"), false);
    assert.equal(output.includes("Official policy decision released"), false);
  }
  assert.match(markdown, /never promotes a source to `active`/);
  assert.match(json, /candidate-for-shadow/);
});
