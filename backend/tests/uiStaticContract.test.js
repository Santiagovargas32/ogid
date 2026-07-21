import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontendDir = path.resolve(backendDir, "../frontend");

async function frontendFile(relativePath) {
  return readFile(path.join(frontendDir, relativePath), "utf8");
}

test("dashboard and admin share valid branding and primary navigation", async () => {
  const [dashboard, admin, brandMark] = await Promise.all([
    frontendFile("index.html"),
    frontendFile("admin.html"),
    frontendFile("assets/ogid-logo.svg")
  ]);

  for (const html of [dashboard, admin]) {
    assert.match(html, /class="ogid-brand"/);
    assert.match(html, /<img src="\/assets\/ogid-logo\.svg" alt="OGID" class="ogid-brand-mark" \/>/);
    assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\/assets\/ogid-logo\.svg" \/>/);
    assert.match(html, /href="\/admin"/);
    assert.match(html, /href="\/"/);
    assert.doesNotMatch(html, /<img[^>]*>\s*<img/i);
  }

  assert.match(brandMark, /^<svg\b/);
  assert.match(brandMark, /viewBox="0 0 512 512"/);
  assert.match(brandMark, /href="data:image\/png;base64,/);
});

test("dashboard keeps map and news contracts without retired admin selectors", async () => {
  const [dashboard, script] = await Promise.all([
    frontendFile("index.html"),
    frontendFile("js/dashboard.js")
  ]);

  assert.match(dashboard, /id="hotspot-map"/);
  assert.match(dashboard, /id="news-feed"/);
  assert.match(dashboard, /Choose instruments/);
  assert.doesNotMatch(dashboard, /up to seven|Choose 7/i);
  assert.doesNotMatch(script, /api-limits-panel|panel-webcams|toggleApiLimitsPanel/);
  assert.match(dashboard, /class="panel panel-vertical market-workspace/);
  assert.match(dashboard, /id="market-ohlcv-summary"/);
  assert.match(dashboard, /col-12 col-xl-6 order-2[\s\S]*?id="panel-risk"/);
  assert.match(dashboard, /col-12 order-1[\s\S]*?id="panel-market"/);
  assert.match(dashboard, /col-12 col-xl-6 order-3[\s\S]*?id="panel-insights"/);
  assert.doesNotMatch(script, /\bformatPrice\(/);
  assert.match(script, /function formatMarketPrice\(/);
  const analytics = dashboard.slice(dashboard.indexOf("dashboard-analytics-row"), dashboard.indexOf("</main>"));
  assert.equal((analytics.match(/col-12 col-xl-4/g) || []).length, 3);
});

test("admin keeps limits near pipeline without redundant fallback diagnostics", async () => {
  const [admin, adminScript] = await Promise.all([
    frontendFile("admin.html"),
    frontendFile("js/admin.js")
  ]);
  assert.ok(admin.indexOf("API Limits Monitor") > admin.indexOf("Pipeline Status"));
  assert.ok(admin.indexOf("API Limits Monitor") < admin.indexOf("AI Enrichments"));
  assert.doesNotMatch(admin, /Fallback Market Provider|market-fallback-diagnostics-body/);
  assert.doesNotMatch(adminScript, /No response preview available/);
});

test("AI enrichment surfaces remain explicitly separated from deterministic content", async () => {
  const [dashboard, admin, script, adminScript] = await Promise.all([
    frontendFile("index.html"),
    frontendFile("admin.html"),
    frontendFile("js/dashboard.js"),
    frontendFile("js/admin.js")
  ]);
  assert.match(dashboard, /id="news-drawer-ai"/);
  assert.match(dashboard, /id="ai-country-shell"/);
  assert.match(dashboard, /id="ai-market-shell"/);
  assert.match(admin, /id="ai-diagnostics-body"/);
  assert.match(admin, /id="ai-enrichments-body"/);
  assert.match(script, /renderAiEvidence/);
  assert.match(adminScript, /const storedCounts = ai\.store\?\.counts \|\| \{\}/);
  assert.match(adminScript, /stored ready:/);
});
