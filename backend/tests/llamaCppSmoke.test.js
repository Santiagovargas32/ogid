import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = mkdtempSync(join(tmpdir(), "ogid-llamacpp-smoke-"));
const emptyEnv = join(directory, "empty.env");
writeFileSync(emptyEnv, "");
after(() => rmSync(directory, { recursive: true, force: true }));
const apiKey = "smoke-sentinel-key";
const privateContent = "private completion that must not be logged";
const completion = (content = '{"ok":true}') => ({
  model: "smoke-model",
  choices: [{ finish_reason: "stop", message: { content, reasoning_content: "private reasoning" } }],
  usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 }
});

function runSmoke({ enabled = true, payload = completion(), status = 200, networkError = false } = {}) {
  // The subprocess exercises the real script, provider, budget and runtime;
  // only HTTP is replaced. It never reads the developer's .env or uses a socket.
  const preload = `globalThis.fetch = async (url) => {
    if (${networkError}) throw new TypeError("private network details");
    if (new URL(url).pathname.endsWith("/models")) return Response.json({data:[{id:"smoke-model"}]});
    return Response.json(${JSON.stringify(payload)}, {status:${status},headers:{"x-request-id":${JSON.stringify(apiKey)}}});
  };`;
  const result = spawnSync(process.execPath, [
    "--import", `data:text/javascript,${encodeURIComponent(preload)}`,
    fileURLToPath(new URL("../scripts/smoke-llamacpp.js", import.meta.url))
  ], {
    encoding: "utf8", timeout: 10_000,
    env: {
      ...process.env, DOTENV_CONFIG_PATH: emptyEnv, RUN_LIVE_LLAMACPP_SMOKE: enabled ? "1" : "0",
      LLAMACPP_BASE_URL: "http://127.0.0.1:8080/v1", LLAMACPP_API_KEY: apiKey,
      LLAMACPP_MODEL_SUMMARY: "smoke-model", LLAMACPP_MODEL_REASONING: "smoke-model",
      LLAMACPP_JSON_MODE: "auto", LLAMACPP_ALLOW_PRIVATE_HTTP: "0",
      AI_MAX_RETRIES: "0", AI_TIMEOUT_MS: "1000", AI_MAX_OUTPUT_TOKENS: "4096"
    }
  });
  assert.ifError(result.error);
  assert.doesNotMatch(result.stdout + result.stderr, /smoke-sentinel-key|private completion|private reasoning|private network details/);
  return { status: result.status, output: JSON.parse(result.stdout) };
}

test("llama.cpp smoke remains opt-in without contacting HTTP", () => {
  const result = runSmoke({ enabled: false, networkError: true });
  assert.equal(result.status, 0);
  assert.equal(result.output.skipped, true);
});

test("llama.cpp smoke validates a real provider result with its isolated budget", () => {
  const result = runSmoke();
  assert.equal(result.status, 0);
  assert.equal(result.output.ok, true);
  assert.equal(result.output.budget.requestsUsed, 1);
  assert.equal(result.output.budget.tokensUsed, 16);
  assert.equal(result.output.responseMetadata.httpStatus, 200);
});

test("llama.cpp smoke exposes safe completion diagnostics on invalid JSON", () => {
  const result = runSmoke({ payload: completion(privateContent) });
  assert.equal(result.status, 1);
  assert.equal(result.output.code, "AI_INVALID_JSON");
  assert.equal(result.output.httpStatus, 200);
  assert.equal(result.output.responseMetadata.finishReason, "stop");
  assert.equal(result.output.responseMetadata.contentLength, privateContent.length);
  assert.equal(result.output.responseMetadata.usage.completionTokens, 6);
  assert.equal(result.output.responseMetadata.hasReasoningContent, true);
  assert.equal(result.output.responseMetadata.requestId, "***");
});

test("llama.cpp smoke preserves HTTP authentication failure classification", () => {
  const result = runSmoke({ payload: { error: { message: privateContent } }, status: 401 });
  assert.equal(result.status, 1);
  assert.equal(result.output.code, "AI_AUTH_FAILED");
  assert.equal(result.output.httpStatus, 401);
});

test("llama.cpp smoke reports no HTTP status when no response was received", () => {
  const result = runSmoke({ networkError: true });
  assert.equal(result.status, 1);
  assert.equal(result.output.code, "network");
  assert.equal(result.output.httpStatus, null);
});
