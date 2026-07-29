import test from "node:test";
import assert from "node:assert/strict";
import { normalizeArticles } from "../services/normalizeService.js";

test("normalizeArticles strips html, derives excerpt/fullText and prefers embedded images over pdfs", () => {
  const articles = normalizeArticles(
    [
      {
        provider: "rss",
        sourceName: "ReliefWeb",
        title: "Lebanon update",
        description:
          '<div class="tag country">Country: Lebanon</div><div class="tag source">Source: OCHA</div><p><img src="https://example.com/thumb.png" alt=""></p><p>Please refer to the attached file.</p><p><strong>Hostilities have continued</strong> across Beirut.</p>',
        content:
          '<p><strong>Hostilities have continued</strong> across Beirut and southern suburbs.</p><p>Displacement has accelerated.</p>',
        urlToImage: "https://example.com/report.pdf",
        url: "https://example.com/report",
        publishedAt: "2026-03-08T12:00:00.000Z"
      }
    ],
    "rss"
  );

  assert.equal(articles.length, 1);
  assert.equal(articles[0].description.includes("<"), false);
  assert.equal(articles[0].fullText.includes("<"), false);
  assert.match(articles[0].excerpt, /Hostilities have continued/i);
  assert.equal(articles[0].leadImageUrl, "https://example.com/thumb.png");
  assert.equal(articles[0].imageUrl, "https://example.com/thumb.png");
});

test("normalizeArticles preserves additive source metadata and provenance", () => {
  const provenance = {
    sourceId: "rss-federal-reserve-press-releases",
    sourceType: "rss",
    methodVersion: "rss-parser-v1",
    publishedAtQuality: "observed"
  };
  const [article] = normalizeArticles([
    {
      provider: "rss",
      source: {
        name: "Federal Reserve Press Releases",
        sourceId: "rss-federal-reserve-press-releases",
        role: "official"
      },
      publisher: "Board of Governors of the Federal Reserve System",
      topics: ["macro", "monetary-policy"],
      instrumentIds: ["us-index-sp500"],
      provenance,
      title: "Federal Reserve issues FOMC statement",
      url: "https://www.federalreserve.gov/newsevents/pressreleases/example.htm",
      publishedAt: "2026-07-29T18:00:00.000Z"
    }
  ], "rss");

  assert.equal(article.sourceId, "rss-federal-reserve-press-releases");
  assert.equal(article.role, "official");
  assert.equal(article.sourceRole, "official");
  assert.equal(article.publisher, "Board of Governors of the Federal Reserve System");
  assert.deepEqual(article.topics, ["macro", "monetary-policy"]);
  assert.deepEqual(article.instrumentIds, ["us-index-sp500"]);
  assert.deepEqual(article.provenance, provenance);
  assert.notEqual(article.provenance, provenance);
});
