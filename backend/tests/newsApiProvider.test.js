import test from "node:test";
import assert from "node:assert/strict";
import { fetchNewsApi, NEWSAPI_MAX_QUERY_LENGTH } from "../services/news/providers/newsApiProvider.js";

test("NewsAPI provider rejects an oversized query before an upstream call", async () => {
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ totalResults: 0, articles: [] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    await assert.rejects(
      fetchNewsApi({
        apiKey: "test-key",
        query: "x".repeat(NEWSAPI_MAX_QUERY_LENGTH + 1),
        language: "en",
        pageSize: 10,
        timeoutMs: 1000
      }),
      (error) => error.code === "newsapi-query-too-long" && error.skipProvider === true
    );
    assert.equal(fetchCalls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});
