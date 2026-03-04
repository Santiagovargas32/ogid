import test from "node:test";
import assert from "node:assert/strict";
import { fetchAggregatedNews } from "../services/news/newsAggregatorService.js";

test("news aggregator falls back when provider keys are missing", async () => {
  const result = await fetchAggregatedNews({
    providers: ["newsapi", "gnews"],
    newsApiKey: "",
    gnewsApiKey: "",
    query: "geopolitics",
    language: "en",
    pageSize: 10,
    timeoutMs: 1000
  });

  assert.equal(result.sourceMode, "fallback");
  assert.ok(Array.isArray(result.articles));
  assert.ok(result.articles.length > 0);
  assert.ok(result.articles.every((article) => article.synthetic === true));
  assert.ok(result.articles.every((article) => article.dataMode === "fallback"));
});
