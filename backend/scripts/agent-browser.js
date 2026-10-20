import { createRequire } from "node:module";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
createRequire(import.meta.url)("../tests/testSetup.cjs");
process.env.LOG_LEVEL = "error";
const { createAppServer } = await import("../server.js");
const { chromium } = await import(
  process.env.OGID_PLAYWRIGHT_MODULE || "playwright"
);
const root = mkdtempSync(join(tmpdir(), "ogid-agent-browser-")),
  output = process.env.OGID_AGENT_BROWSER_OUTPUT || root;
mkdirSync(output, { recursive: true });
const model = {
  alias: "fixture-ui",
  state: "ready",
  context: 8192,
  tools: true,
  structuredOutput: true,
  serverContextVerified: true,
  probe: {
    verifiedAt: new Date().toISOString(),
    wireNoFixedCap: true,
    streaming: true,
    cancellation: true,
  },
};
const runtime = createAppServer({
  port: 0,
  host: "127.0.0.1",
  disableBackgroundRefresh: true,
  storage: {
    enabled: true,
    businessEnabled: true,
    databasePath: join(root, "fixture.sqlite"),
  },
  market: { provider: "", historyPersist: false },
  news: { providers: [], rssFeeds: [] },
  agent: {
    mode: "visible",
    manifest: {
      schemaVersion: "ogid-model-catalog-v1",
      models: [model, { ...model, alias: "fixture-ui-2" }],
    },
    backgroundModel: "llamacpp/fixture-ui",
  },
});
// This is a UI fixture, not a connection to the operator's OpenCode instance.
// Supply only the v2 catalog contract needed by the picker. Actual OpenCode
// availability/inference are covered separately by terminal-managed smoke.
runtime.app.locals.agentModels.opencode={models:async()=>({data:['fixture-ui','fixture-ui-2'].map(modelID=>({providerID:'llamacpp',modelID,enabled:true,limit:{context:8192},capabilities:{tools:true}}))})};
const result = {
  kind: "browser-fixture; not predictive validation",
  screenshots: [],
  checks: [],
  errors: [],
  youtubeRequests: 0,
};
let browser, activePage;
try {
  await runtime.start();
  const base = `http://127.0.0.1:${runtime.server.address().port}`,
    call = runtime.app.locals.agentCall;
  await call("enqueue", {
    task: "global_intelligence_brief",
    model: "llamacpp/fixture-ui",
    key: "browser-fixture",
    priority: 10,
  });
  const job = await call("claim", { owner: "browser" }),
    auth = { jobId: job.jobId, owner: "browser", fence: job.fence },
    snap = await call("snapshot", auth),
    page = await call("evidence", { snapshotId: snap.snapshotId });
  await call("publish", {
    ...auth,
    mode: "visible",
    proposal: {
      schemaVersion: "ogid-agent-publication-v1",
      task: "global_intelligence_brief",
      summary: "Fixture UI: <img src=x onerror=alert(1)> · cobertura parcial",
      direction: "unavailable",
      sentiment: "unavailable",
      stability: "unavailable",
      horizonHours: 24,
      probability: null,
      confidenceKind: "qualitative-uncalibrated",
      evidenceIds: [page.items[0].evidenceId],
      contradictions: ["Fixture; no es evidencia de mercado"],
      invalidation: [],
      limitations: ["Datos simulados para validar interfaz"],
      technicalFacts: [],
    },
  });
  const assets = new Map();
  for (const url of [
    "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css",
    "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js",
    "https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js",
  ]) {
    const name = url.includes("bootstrap")
      ? url.endsWith(".css")
        ? "bootstrap.css"
        : "bootstrap.js"
      : "chart.js";
    assets.set(url, {
      body: readFileSync(
        join(process.env.OGID_AGENT_CDN || "/tmp/ogid-agent-cdn", name),
      ),
      contentType: url.endsWith(".css") ? "text/css" : "text/javascript",
    });
  }
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  result.browser = browser.version();
  for (const [width, height] of [
    [1920, 1080],
    [1366, 768],
    [390, 844],
  ]) {
    const context = await browser.newContext({
        viewport: { width, height },
        reducedMotion: "reduce",
      }),
      p = await context.newPage();
    activePage = p;
    p.on("pageerror", (e) => result.errors.push(e.message));
    p.on("request", (r) => {
      if (/youtube|ytimg/.test(r.url())) result.youtubeRequests++;
    });
    await context.route("**/*", (route) => {
      const u = route.request().url();
      if (u.startsWith(base)) return route.continue();
      if (assets.has(u)) return route.fulfill(assets.get(u));
      return route.abort();
    });
    await p.goto(base, { waitUntil: "networkidle" });
    await p.waitForSelector("#agent-brief-body .agent-publication");
    assert.equal(await p.locator(".intel-grid-advanced > article").count(), 6);
    assert.equal(await p.locator("#agent-brief-body img").count(), 0);
    assert.equal(await p.locator("#situational-workspace-panel").count(), 0);
    assert.equal(await p.locator("#panel-awareness").isVisible(), true);
    assert.equal(await p.locator("#awareness-upcoming-list").count(), 1);
    assert.equal(await p.locator("#agent-geopolitical-body").count(), 1);
    if (width >= 992) {
      const columns = await p
        .locator(".intel-grid-advanced")
        .evaluate(
          (e) => getComputedStyle(e).gridTemplateColumns.split(" ").length,
        );
      assert.equal(columns, 3);
    }
    await p
      .locator("#agent-brief-body")
      .getByRole("button", { name: "Consultar al agente" })
      .click();
    await p.getByRole("dialog").waitFor();
    await p.getByRole("button", { name: "Autorizar dispositivo" }).click();
    await p.waitForFunction(
      () =>
        document.querySelector("dialog [data-status]").textContent ===
        "Dispositivo autorizado",
    );
    assert.equal(await p.locator("dialog textarea").isVisible(), true);
    await p
      .locator("dialog [data-model]")
      .selectOption("llamacpp/fixture-ui-2");
    const query = `Fixture ${width}: consulta con modelo alternativo`;
    await p.locator("dialog textarea").fill(query);
    await p.locator("dialog button[type=submit]").click();
    await p.waitForFunction(
      () =>
        ["En cola", "queued"].includes(document.querySelector("dialog [data-status]").textContent),
    );
    const savedSession = await p.locator("dialog [data-session]").inputValue();
    const turn = await call("claim", {
      owner: "fixture-browser",
      enabledTasks: ["contextual_chat"],
    });
    assert.equal(turn.model, "llamacpp/fixture-ui-2");
    runtime.app.locals.agentProgress.set(savedSession, {
      jobId: turn.jobId,
      text: "Fixture: respuesta parcial segura",
      tools: [{ name: "ogid_query", status: "running" }],
    });
    await p
      .locator("dialog [data-stream]")
      .getByText("Fixture: respuesta parcial segura")
      .waitFor();
    // A restarted backend loses its ephemeral SSE projection. The history API
    // must restore the active run so cancellation still works after reload.
    runtime.app.locals.agentProgress.delete(savedSession);
    await p.reload({ waitUntil: "networkidle" });
    await p.locator("#agent-chat-open").click();
    await p
      .locator(`dialog [data-session] option[value="${savedSession}"]`)
      .waitFor({ state: "attached" });
    await p.locator("dialog [data-session]").selectOption(savedSession);
    await p.waitForFunction(
      () =>
        document.querySelector("dialog [data-status]").textContent ===
        "running",
    );
    await p.locator("dialog [data-cancel]").click();
    await p.waitForFunction(
      () =>
        document.querySelector("dialog [data-status]").textContent ===
        "Cancelación solicitada",
    );
    assert.equal(
      (await call("run", { jobId: turn.jobId, internal: true })).status,
      "cancelled",
    );
    runtime.app.locals.agentProgress.set(savedSession, {
      jobId: turn.jobId,
      done: true,
    });
    await p.locator("dialog [data-close]").click();
    await p.reload({ waitUntil: "networkidle" });
    await p.locator("#agent-chat-open").click();
    await p
      .locator(`dialog [data-session] option[value="${savedSession}"]`)
      .waitFor({ state: "attached" });
    await p.locator("dialog [data-session]").selectOption(savedSession);
    await p
      .locator("dialog [data-messages]")
      .getByText(query, { exact: true })
      .waitFor();
    await p.locator("dialog [data-close]").click();
    const screenshot = join(output, `agent-${width}.png`);
    await p.screenshot({ path: screenshot, fullPage: true });
    result.screenshots.push(screenshot);
    result.checks.push(
      `${width}x${height}: six cards, Awareness, inbox, safe text, device enrollment, fixture model change, SSE progress, active-run recovery without ephemeral events, cancellation and history after reload`,
    );
    await context.close();
  }
  assert.equal(result.youtubeRequests, 0);
  assert.deepEqual(result.errors, []);
  result.status = "passed";
} catch (e) {
  result.status = "failed";
  result.failure = e.message;
  result.failureLocation = e.stack?.split("\n").filter(line => line.includes("agent-browser.js"));
  result.lastUiState = await activePage?.evaluate(() => ({
    status: document.querySelector("dialog [data-status]")?.textContent,
    sessionId: document.querySelector("dialog [data-session]")?.value,
    selectedModel: document.querySelector("dialog [data-model]")?.value,
  })).catch(() => null);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await runtime.stop();
  writeFileSync(
    join(output, "browser.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      status: result.status,
      output,
      failure: result.failure || null,
    }),
  );
}
