import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCountryFilter,
  filterNewsBySources,
  parseCountries,
  parseSources
} from "../utils/filters.js";

test("parseCountries handles ALL and defaults", () => {
  assert.deepEqual(parseCountries(undefined, ["US", "IL"]), ["US", "IL"]);
  const all = parseCountries("ALL", ["US"]);
  assert.ok(all.includes("US"));
  assert.ok(all.includes("IR"));
});

test("filterNewsBySources keeps requested providers only", () => {
  const news = [
    { id: "1", provider: "newsapi" },
    { id: "2", provider: "gnews" },
    { id: "4", provider: "rss" },
    { id: "3", provider: "fallback" }
  ];

  const filtered = filterNewsBySources(news, parseSources("newsapi,gnews,rss"));
  assert.equal(filtered.length, 3);
  assert.ok(filtered.every((item) => ["newsapi", "gnews", "rss"].includes(item.provider)));
});

test("parseSources accepts rss and gdelt providers", () => {
  assert.deepEqual(parseSources("rss,gdelt,fallback"), ["rss", "gdelt", "fallback"]);
});

test("applyCountryFilter trims snapshot by selected countries", () => {
  const snapshot = {
    news: [{ id: "a", countryMentions: ["US"] }, { id: "b", countryMentions: ["IR"] }],
    hotspots: [{ iso2: "US" }, { iso2: "IR" }],
    countries: { US: { iso2: "US" }, IR: { iso2: "IR" } },
    insights: [{ iso2: "US" }, { iso2: "IR" }],
    impact: { items: [{ linkedCountries: ["US"] }, { linkedCountries: ["IR"] }] }
  };

  const filtered = applyCountryFilter(snapshot, ["US"]);
  assert.equal(filtered.news.length, 1);
  assert.equal(filtered.hotspots.length, 1);
  assert.equal(Object.keys(filtered.countries).length, 1);
  assert.equal(filtered.insights.length, 1);
  assert.equal(filtered.impact.items.length, 1);
});
