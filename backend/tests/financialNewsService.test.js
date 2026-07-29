import test from "node:test";
import assert from "node:assert/strict";
import { normalizeArticles } from "../services/normalizeService.js";
import {
  buildFinancialNewsSelection,
  buildNewsLaneRotation,
  classifyFinancialArticle,
  deduplicateFinancialArticles,
  mergeNewsLanesByRotation,
  partitionNewsArticles
} from "../services/news/financialNewsService.js";
import { buildIntelNewsSelection } from "../services/news/newsSelectionService.js";

const NOW = "2026-07-29T19:00:00.000Z";

function normalizedArticle(overrides = {}) {
  return normalizeArticles([
    {
      provider: "rss",
      sourceName: "Fixture News",
      title: "Market update",
      description: "Observed update.",
      url: "https://example.test/article",
      publishedAt: "2026-07-29T18:00:00.000Z",
      ...overrides
    }
  ], "rss")[0];
}

test("Fed releases without a country enter the independent financial selection", () => {
  const article = normalizedArticle({
    source: {
      name: "Federal Reserve Press Releases",
      sourceId: "rss-federal-reserve-press-releases",
      role: "official"
    },
    title: "Federal Reserve issues FOMC statement",
    description: "The Committee decided to maintain the target range for the federal funds rate.",
    url: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260729a.htm"
  });

  assert.deepEqual(article.countryMentions, []);
  const selection = buildFinancialNewsSelection({ articles: [article], now: NOW });
  assert.equal(selection.items.length, 1);
  assert.equal(selection.items[0].financial.domains.includes("macro"), true);
  assert.equal(selection.items[0].financial.importance.methodVersion, "financial-importance-rule-v1");
  assert.ok(["high", "critical"].includes(selection.items[0].financial.importance.band));
});

test("rule-v1 makes CPI, employment, GDP and PCE official releases high importance", () => {
  for (const title of [
    "Consumer Price Index release",
    "Employment Situation and nonfarm payrolls",
    "Gross Domestic Product release",
    "Personal Consumption Expenditures PCE release"
  ]) {
    const article = normalizedArticle({
      source: { name: "Official statistics agency", sourceId: "official-statistics", role: "official" },
      title,
      url: `https://example.test/${encodeURIComponent(title)}`
    });
    const selection = buildFinancialNewsSelection({ articles: [article], now: NOW });
    assert.equal(selection.items.length, 1, title);
    assert.ok(["high", "critical"].includes(selection.items[0].financial.importance.band), title);
  }
});

test("known official financial feeds bypass keyword dependence without admitting Defense releases", () => {
  const eia = normalizedArticle({
    source: { name: "EIA Today in Energy", sourceId: "rss-eia-today-in-energy", role: "official" },
    title: "Weekly publication available",
    description: "The latest official dataset is now available.",
    url: "https://www.eia.gov/todayinenergy/detail.php?id=1"
  });
  const defense = normalizedArticle({
    source: { name: "U.S. Defense Releases", sourceId: "rss-us-defense-releases", role: "official" },
    title: "Weekly publication available",
    description: "The latest official update is now available.",
    url: "https://www.war.gov/News/Releases/Release/Article/1"
  });
  assert.equal(classifyFinancialArticle(eia).financial.isFinancial, true);
  assert.equal(classifyFinancialArticle(defense).financial.isFinancial, false);
});

test("a hybrid official release remains eligible for geopolitical and financial branches", () => {
  const article = normalizedArticle({
    source: {
      name: "Federal Reserve Press Releases",
      sourceId: "rss-federal-reserve-press-releases",
      role: "official"
    },
    title: "Federal Reserve statement on sanctions after missile attack in Iran",
    description: "The central bank outlined new asset freeze controls after the ballistic missile attack.",
    url: "https://example.test/hybrid-release"
  });

  const classification = classifyFinancialArticle(article);
  assert.deepEqual(classification.financial.domains, ["macro", "regulatory"]);
  assert.ok(article.conflict.totalWeight > 0);
  const branches = partitionNewsArticles([article]);
  assert.equal(branches.geopolitical[0]?.id, article.id);
  assert.equal(branches.financial[0]?.id, article.id);
  assert.equal(branches.hybrid[0]?.id, article.id);

  const geopolitical = buildIntelNewsSelection({
    articles: [article],
    watchlistCountries: ["IR"],
    now: NOW,
    analyzeLimit: 10
  });
  const financial = buildFinancialNewsSelection({ articles: [article], now: NOW });
  assert.equal(geopolitical.signalCorpus.some((item) => item.id === article.id), true);
  assert.equal(financial.items.some((item) => item.id === article.id), true);
});

test("a pure macro release is excluded from the geopolitical branch", () => {
  const article = normalizedArticle({
    source: {
      name: "Federal Reserve Press Releases",
      sourceId: "rss-federal-reserve-press-releases",
      role: "official"
    },
    title: "Federal Reserve issues FOMC interest rate decision",
    description: "The Committee maintained the target range for the federal funds rate.",
    url: "https://example.test/fomc-release"
  });

  const branches = partitionNewsArticles([article]);
  assert.equal(branches.geopolitical.length, 0);
  assert.equal(branches.financial[0]?.id, article.id);
  assert.equal(branches.hybrid.length, 0);
});

test("official financial releases rank above equivalent editorial coverage and win dedupe", () => {
  const official = normalizedArticle({
    source: { name: "Federal Reserve", sourceId: "fed-official", role: "official" },
    title: "Federal Reserve interest rate decision",
    description: "The FOMC published its monetary policy decision.",
    url: "https://federalreserve.gov/example"
  });
  const editorial = normalizedArticle({
    source: { name: "Market Blog", sourceId: "market-blog", role: "editorial" },
    title: "Analysts review the Federal Reserve interest rate decision",
    description: "The FOMC monetary policy decision is unchanged.",
    url: "https://example.test/editorial"
  });

  const selection = buildFinancialNewsSelection({ articles: [editorial, official], now: NOW });
  assert.equal(selection.items[0].sourceRole, "official");
  assert.ok(selection.items[0].financialImportanceScore > selection.items[1].financialImportanceScore);

  const duplicateEditorial = {
    ...selection.items[1],
    title: official.title,
    url: `${official.url}?utm_source=syndication`
  };
  const deduped = deduplicateFinancialArticles([duplicateEditorial, selection.items[0]]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].sourceRole, "official");
});

test("the reusable lane rotation is deterministic, 70/30 and dedupes hybrids", () => {
  const schedule = buildNewsLaneRotation({ slots: 10 });
  assert.equal(schedule.filter((lane) => lane === "geopolitical").length, 7);
  assert.equal(schedule.filter((lane) => lane === "financial").length, 3);
  assert.deepEqual(buildNewsLaneRotation({ slots: 10 }), schedule);

  const hybrid = { id: "hybrid", title: "Hybrid", url: "https://example.test/hybrid" };
  const geopoliticalItems = [hybrid, ...Array.from({ length: 9 }, (_, index) => ({
    id: `g-${index}`,
    title: `Geopolitical ${index}`,
    url: `https://example.test/g-${index}`
  }))];
  const financialItems = [hybrid, ...Array.from({ length: 9 }, (_, index) => ({
    id: `f-${index}`,
    title: `Financial ${index}`,
    url: `https://example.test/f-${index}`
  }))];
  const merged = mergeNewsLanesByRotation({ geopoliticalItems, financialItems, limit: 10 });

  assert.equal(merged.items.length, 10);
  assert.equal(merged.items.filter((item) => item.id === "hybrid").length, 1);
  assert.equal(merged.policy.geopoliticalPercent, 70);
  assert.equal(merged.policy.financialPercent, 30);
});
