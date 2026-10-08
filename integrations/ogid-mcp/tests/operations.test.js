import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { OGID_OPERATIONS, operationPath } from "../../../backend/contracts/ogidOperations.js";
import { projectOperation } from "../../../backend/utils/researchProjection.js";
import { loadConfig } from "../src/config.js";
import { createReadClient } from "../src/client.js";
import { toolDefinitions, executeTool } from "../src/tools.js";
import { zodSchema } from "../src/operations.js";
const token = "fixture_" + "k".repeat(48);
function requiredSample(definition) {
  return Object.fromEntries((definition.required || []).map(key => {
    const def = definition.properties[key];
    const value = def.type === "object" ? requiredSample(def) : def.type === "array" ? ["fixture-id"] : def.format === "date-time" ? "2026-10-06T12:00:00Z" : def.type === "integer" ? def.minimum || 1 : def.enum?.[0] || (key === "q" ? "NVDA" : key === "currency" ? "USD" : "fixture-id");
    return [key, value];
  }));
}
test("cada operación operador usa método/ruta/esquema fijo, credencial de alcance y proyección revisada", async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, url: req.url, id: req.headers["x-ogid-mcp-operation"], auth: req.headers.authorization, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined });
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, data: { generatedAt: "2026-10-06T12:00:00Z", summary: { count: 3, token: "DO_NOT_LEAK" }, items: [{ fullText: "DO_NOT_LEAK" }], token: "DO_NOT_LEAK", historyDir: "/home/private" } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const operations = OGID_OPERATIONS.filter(operation => operation.profile === "operator");
  const config = { ...loadConfig({}), baseUrl: `http://127.0.0.1:${server.address().port}`, profile: "operator", operatorCredential: { token, scopes: [...new Set(operations.map(operation => operation.scope))] } };
  const read = createReadClient(config);
  try {
    for (const operation of operations) {
      const params = requiredSample(operation.parameters); const body = operation.body ? requiredSample(operation.body) : undefined; const path = operation.pathParameters ? { id: "fixture-id" } : undefined;
      const data = await read.operation(operation.id, params, body, path); const request = requests.at(-1);
      assert.equal(request.id, operation.id); assert.equal(request.auth, "Bearer " + token); assert.equal(request.method, operation.method);
      assert.equal(new URL(request.url, config.baseUrl).pathname, operationPath(operation, path)); assert.deepEqual(request.body, body);
      for (const [key, value] of Object.entries(operation.fixed)) assert.equal(new URL(request.url, config.baseUrl).searchParams.get(key), String(value));
      assert.ok(!JSON.stringify(projectOperation(operation, data)).includes("DO_NOT_LEAK"));
      assert.throws(() => zodSchema(operation.parameters).parse({ ...params, url: "http://evil" }));
      assert.throws(() => zodSchema(operation.parameters).parse({ ...params, force: true }));
    }
    const limited = { ...config, operatorCredential: { token, scopes: ["admin:read"] } };
    const tool = toolDefinitions(limited, createReadClient(limited)).find(item => item.name === "ogid_operator"); assert.ok(tool);
    assert.equal((await executeTool(tool, { operationId: "market.watchlist.update", body: { instrumentIds: [] } }, limited)).isError, true);
    const research = toolDefinitions(loadConfig({}), async () => ({})); assert.ok(!research.some(item => item.name === "ogid_operator"));
    const query = research.find(item => item.name === "ogid_query");
    for (const operation of operations) assert.throws(() => query.schema.parse({ operationId: operation.id, parameters: {} }));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test("credenciales operador privadas, perfil inválido y secretos nunca publicados en discovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "ogid-credential-test-")); const file = join(root, "credential.json");
  writeFileSync(file, JSON.stringify({ token, scopes: ["admin:read"] }), { mode: 0o600 });
  const config = loadConfig({ OGID_PROFILE: "operator", OGID_OPERATOR_CREDENTIAL_FILE: file }); assert.equal(config.profile, "operator");
  assert.throws(() => loadConfig({ OGID_PROFILE: "operator" })); assert.throws(() => loadConfig({ OGID_PROFILE: "invalid" }));
  const tools = toolDefinitions(config, async () => ({ contractVersion: "1.0.0", newsCoverage: {} }));
  const output = await executeTool(tools.find(tool => tool.name === "ogid_get_capabilities"), {}, config); assert.equal(output.isError, undefined); assert.ok(!JSON.stringify(output).includes(token));
  chmodSync(file, 0o644); assert.throws(() => loadConfig({ OGID_PROFILE: "operator", OGID_OPERATOR_CREDENTIAL_FILE: file }));
});
test("el cliente acota concurrencia y no reintenta mutaciones ante 503", async () => {
  let active = 0; let peak = 0; let writes = 0;
  const mock = async (_url, options) => {
    if (options.method !== "GET") { writes++; return new Response("DO_NOT_LEAK", { status: 503 }); }
    active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 10)); active--;
    return new Response(JSON.stringify({ ok: true, data: { status: "ok" } }), { headers: { "content-type": "application/json" } });
  };
  const config = { ...loadConfig({}), maxConcurrent: 2, profile: "operator", operatorCredential: { token, scopes: ["intel:refresh"] } }; const read = createReadClient(config, mock);
  await Promise.all(Array.from({ length: 8 }, () => read("/api/health"))); assert.equal(peak, 2);
  await assert.rejects(read.operation("intel.refresh", {}, {})); assert.equal(writes, 1);
});
