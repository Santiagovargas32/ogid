import test from "node:test";
import assert from "node:assert/strict";
import { createAppServer } from "../server.js";

test("AI layer is additive and performs no work when off", async () => {
  const runtime = createAppServer({
    port: 0,
    runtime: { disableBackgroundRefresh: true },
    market: { enabled: false, provider: "", historyPersist: false },
    ai: { provider: "none", mode: "off", stateFile: null, budgetStateFile: null }
  });
  await runtime.start();
  const baseUrl = `http://127.0.0.1:${runtime.server.address().port}`;
  try {
    const snapshotResponse = await fetch(`${baseUrl}/api/intel/snapshot?countries=ALL`);
    assert.equal(snapshotResponse.status, 200);
    const snapshot = await snapshotResponse.json();
    assert.equal(snapshot.data.ai.enabled, false);
    assert.equal(snapshot.data.ai.mode, "off");
    assert.deepEqual(snapshot.data.ai.articleSummaries, {});

    const pipelineResponse = await fetch(`${baseUrl}/api/admin/pipeline-status`);
    const pipeline = await pipelineResponse.json();
    assert.equal(pipeline.data.ai.activeProvider, "none");
    assert.equal(pipeline.data.ai.transport.calls, 0);

    const recordsResponse = await fetch(`${baseUrl}/api/admin/ai-enrichments?page=1&pageSize=10`);
    const records = await recordsResponse.json();
    assert.equal(recordsResponse.status, 200);
    assert.equal(records.data.pagination.totalItems, 0);

    const invalidQuery = await fetch(`${baseUrl}/api/admin/ai-enrichments?rawPrompt=1`);
    assert.equal(invalidQuery.status, 404);
  } finally {
    await runtime.stop();
  }
});
