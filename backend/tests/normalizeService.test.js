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
