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
  const [dashboard, script, styles, apiScript, conditionsModel] = await Promise.all([
    frontendFile("index.html"),
    frontendFile("js/dashboard.js"),
    frontendFile("css/styles.css"),
    frontendFile("js/api.js"),
    frontendFile("js/marketConditionsModel.js")
  ]);

  assert.match(dashboard, /id="hotspot-map"/);
  assert.match(dashboard, /id="news-feed"/);
  assert.match(dashboard, /Choose instruments/);
  assert.doesNotMatch(dashboard, /up to seven|Choose 7/i);
  assert.doesNotMatch(script, /api-limits-panel|panel-webcams|toggleApiLimitsPanel/);
  assert.match(dashboard, /class="panel panel-vertical market-workspace/);
  assert.match(dashboard, /id="market-ohlcv-summary"/);
  assert.match(dashboard, /col-12 order-1[\s\S]*?id="panel-risk"/);
  assert.match(dashboard, /col-12 order-2[\s\S]*?id="panel-market"/);
  assert.match(dashboard, /col-12 order-3[\s\S]*?id="panel-market-conditions"/);
  assert.ok(dashboard.indexOf('id="panel-risk"') < dashboard.indexOf('id="panel-market"'));
  assert.ok(dashboard.indexOf('id="panel-market"') < dashboard.indexOf('id="panel-market-conditions"'));
  assert.doesNotMatch(script, /\bformatPrice\(/);
  assert.match(script, /function formatMarketPrice\(/);
  assert.equal((dashboard.match(/class="market-conditions-column"/g) || []).length, 3);
  assert.match(dashboard, /id="market-conditions-window-selector"/);
  assert.match(dashboard, /id="market-conditions-general"/);
  assert.match(dashboard, /id="market-conditions-symbols"/);
  assert.match(dashboard, /id="market-conditions-countries"/);
  assert.match(dashboard, /Inputs: initializing/);
  assert.doesNotMatch(dashboard, /dashboard-analytics-row|market-impact-list|impact-timeline-chart|sector-breakdown-chart|impact-scatter-chart/);
  assert.doesNotMatch(script, /getMarketAnalytics|initImpactTimelineChart|initSectorBreakdownChart|initImpactScatterChart/);
  assert.match(apiScript, /getMarketConditions: \(params = \{\}\) => request\("\/api\/market\/conditions"/);
  assert.match(apiScript, /getMarketAnalytics: \(params = \{\}\) => request\("\/api\/market\/analytics"/);
  assert.match(script, /message\.type === "awareness:update:v1"[\s\S]*?scheduleMarketConditionsRefresh\(\)/);
  assert.match(script, /await refreshMarketConditions\(\)/);
  assert.match(conditionsModel, /DEFAULT_MARKET_CONDITIONS_WINDOW_MIN = 240/);
  assert.match(conditionsModel, /minutes: 15/);
  assert.match(conditionsModel, /minutes: 60/);
  assert.match(conditionsModel, /minutes: 240/);
  assert.match(conditionsModel, /minutes: 1440/);
  assert.match(conditionsModel, /primaryReason/);
  assert.match(conditionsModel, /market_closed/);
  assert.match(conditionsModel, /stale_local_data/);
  assert.match(conditionsModel, /no_5m_history/);
  assert.match(conditionsModel, /outside_intraday_limit/);
  assert.match(script, /aria-label="Availability:/);
  assert.match(script, /Input quality:/);
  assert.match(script, /market-condition-availability-message/);
  assert.doesNotMatch(script, /--gauge-value: \$\{symbol\.operabilityScore \?\? 0\}/);
  assert.match(styles, /\.availability-status-market_closed/);
  assert.match(styles, /\.availability-status-stale_local_data/);
  assert.match(styles, /\.availability-status-no_5m_history/);
  assert.match(styles, /\.availability-status-outside_intraday_limit/);
  assert.match(styles, /\.availability-status-warming_up/);
  assert.match(styles, /\.market-conditions-grid\s*\{[\s\S]*?grid-template-columns: repeat\(3/);
  assert.match(styles, /@media \(max-width: 1199\.98px\)[\s\S]*?\.market-conditions-grid\s*\{[\s\S]*?repeat\(2/);
  assert.match(styles, /@media \(max-width: 767\.98px\)[\s\S]*?\.market-conditions-grid\s*\{[\s\S]*?minmax\(0, 1fr\)/);
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
  assert.match(script, /ai\.enabled === true && ai\.mode === "visible"/);
  assert.match(script, /\["none", "off", "disabled"\]\.includes\(provider\)/);
  assert.doesNotMatch(`${dashboard}\n${script}`, /AI:\s*live/i);
  assert.match(adminScript, /const storedCounts = ai\.store\?\.counts \|\| \{\}/);
  assert.match(adminScript, /stored ready:/);
});
