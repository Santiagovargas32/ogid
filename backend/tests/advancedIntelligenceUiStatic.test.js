import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontendDir = path.resolve(backendDir, "../frontend");

function frontendFile(relativePath) {
  return readFile(path.join(frontendDir, relativePath), "utf8");
}

test("advanced intelligence panels share one filtered snapshot polling contract", async () => {
  const [dashboard, api, page, coordinator, worldBrief, risk, severity, terms, hotspots, anomalies] = await Promise.all([
    frontendFile("js/dashboard.js"),
    frontendFile("js/api.js"),
    frontendFile("index.html"),
    frontendFile("js/intelligence/advancedIntelligence.js"),
    frontendFile("js/intelligence/worldBrief.js"),
    frontendFile("js/intelligence/riskEngine.js"),
    frontendFile("js/intelligence/threatClassifier.js"),
    frontendFile("js/intelligence/trendDetector.js"),
    frontendFile("js/intelligence/escalationHotspots.js"),
    frontendFile("js/intelligence/signalAnomalies.js")
  ]);

  assert.match(page, /id="advanced-intel-meta"/);
  assert.match(page, /Country Instability Index/);
  assert.match(page, /Rule-based News Severity/);
  assert.match(page, /Frequent Headline Terms/);
  assert.match(api, /getAdvancedIntelligenceSnapshot:[\s\S]*?\/api\/intel\/advanced-snapshot/);
  assert.match(dashboard, /startAdvancedIntelligence\(\{ api, getCountries: selectedCountryQueryValue \}\)/);
  assert.doesNotMatch(dashboard, /startWorldBrief|startThreatClassifier|startRiskEngine|startTrendDetector|startEscalationHotspots|startSignalAnomalies/);

  const intelligenceScripts = [coordinator, worldBrief, risk, severity, terms, hotspots, anomalies].join("\n");
  assert.equal((intelligenceScripts.match(/new SmartPollLoop/g) || []).length, 1);
  assert.match(coordinator, /pendingRefresh/);
  assert.match(coordinator, /requestToken/);
  assert.match(worldBrief, /brief\.articles/);
  assert.match(worldBrief, /safeHttpUrl/);
  assert.doesNotMatch(worldBrief, /getAggregateNews|getHotspotsV2/);
  assert.match(hotspots, /item\.components/);
  assert.match(risk, /explanation\.formula/);
  assert.match(anomalies, /item\.status === "ready"/);
  assert.match(anomalies, /item\.anomalyScore !== null/);
  assert.match(anomalies, /Baseline insuficiente/);
  assert.doesNotMatch(anomalies, /slice\(0, 5\)/);
  assert.match(coordinator, /lastSnapshotContext/);
  assert.match(coordinator, /renderedSections/);
});
