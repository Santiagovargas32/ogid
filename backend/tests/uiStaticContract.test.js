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
  const [dashboard, admin] = await Promise.all([
    frontendFile("index.html"),
    frontendFile("admin.html")
  ]);

  for (const html of [dashboard, admin]) {
    assert.match(html, /class="ogid-brand"/);
    assert.match(html, /class="ogid-brand-mark"/);
    assert.match(html, /href="\/admin"/);
    assert.match(html, /href="\/"/);
    assert.doesNotMatch(html, /<img[^>]*>\s*<img/i);
  }
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
});
