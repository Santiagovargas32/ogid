import test from "node:test";
import assert from "node:assert/strict";
import { fetchGdelt, resetGdeltThrottleForTests } from "../services/news/providers/gdeltProvider.js";

test("gdelt provider enforces local cooldown after a successful call", async () => {
  resetGdeltThrottleForTests();

  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        articles: [
          {
            title: "Shipping lane disruption",
            url: "https://example.com/gdelt-1",
            seendate: new Date().toISOString()
          }
        ]
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    );

  try {
    const result = await fetchGdelt({
      baseUrl: "https://api.gdeltproject.org/api/v2/doc/doc",
      query: "shipping lane",
      pageSize: 5,
      timeoutMs: 1000
    });

    assert.equal(result.provider, "gdelt");
    assert.ok(result.sourceMeta.nextAllowedAt);

    await assert.rejects(
      fetchGdelt({
        baseUrl: "https://api.gdeltproject.org/api/v2/doc/doc",
        query: "shipping lane",
        pageSize: 5,
        timeoutMs: 1000
      }),
      (error) => error?.message === "gdelt-cooldown-active" && error?.skipReason === "cooldown" && Boolean(error?.nextAllowedAt)
    );
  } finally {
    global.fetch = originalFetch;
    resetGdeltThrottleForTests();
  }
});

test("gdelt provider applies backoff and nextAllowedAt after upstream 429", async () => {
  resetGdeltThrottleForTests();

  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response("rate limited", {
      status: 429,
      headers: { "content-type": "text/plain" }
    });

  try {
    await assert.rejects(
      fetchGdelt({
        baseUrl: "https://api.gdeltproject.org/api/v2/doc/doc",
        query: "oil tanker",
        pageSize: 5,
        timeoutMs: 1000
      }),
      (error) => error?.message?.startsWith("gdelt-upstream-429:") && Boolean(error?.nextAllowedAt)
    );

    await assert.rejects(
      fetchGdelt({
        baseUrl: "https://api.gdeltproject.org/api/v2/doc/doc",
        query: "oil tanker",
        pageSize: 5,
        timeoutMs: 1000
      }),
      (error) => error?.message === "gdelt-cooldown-active" && error?.skipReason === "cooldown" && Boolean(error?.nextAllowedAt)
    );
  } finally {
    global.fetch = originalFetch;
    resetGdeltThrottleForTests();
  }
});

test("gdelt provider classifies non-json success bodies as invalid-body and applies cooldown", async () => {
  resetGdeltThrottleForTests();

  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response("You have reached your query limit", {
      status: 200,
      headers: { "content-type": "text/plain" }
    });

  try {
    await assert.rejects(
      fetchGdelt({
        baseUrl: "https://api.gdeltproject.org/api/v2/doc/doc",
        query: "oil tanker",
        pageSize: 5,
        timeoutMs: 1000
      }),
      (error) => error?.code === "invalid-body" && error?.message?.startsWith("gdelt-invalid-body:") && Boolean(error?.nextAllowedAt)
    );

    await assert.rejects(
      fetchGdelt({
        baseUrl: "https://api.gdeltproject.org/api/v2/doc/doc",
        query: "oil tanker",
        pageSize: 5,
        timeoutMs: 1000
      }),
      (error) => error?.message === "gdelt-cooldown-active" && error?.skipReason === "cooldown" && Boolean(error?.nextAllowedAt)
    );
  } finally {
    global.fetch = originalFetch;
    resetGdeltThrottleForTests();
  }
});
