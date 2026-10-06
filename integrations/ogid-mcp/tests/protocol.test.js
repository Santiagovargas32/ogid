import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("MCP stdio real: catálogo ampliado, cuatro herramientas compatibles e inputs rechazados", async () => {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    res.setHeader("content-type", "application/json");
    const data = req.url.startsWith('/api/health') ? { status: "ok", dataQuality: { news: { synthetic: false } } }
      : req.url.startsWith('/api/intel/news') ? { news: [{ id: "fixture", title: "Fixture", provider: "rss", url: "https://example.org/news", publishedAt: new Date().toISOString() }], meta: { lastRefreshAt: new Date().toISOString() } }
      : { mode: "visible", schemaVersion: "awareness-v1", revision: 1, generatedAt: new Date().toISOString(), upcoming: [], recent: [], sourceStatus: [], quality: { total: 0 } };
    res.end(JSON.stringify({ ok: true, data }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
    env: { PATH: process.env.PATH, OGID_BASE_URL: `http://127.0.0.1:${server.address().port}` }, stderr: "pipe"
  });
  let stderr = "";
  transport.stderr.on('data', b => { stderr += b; });
  const client = new Client({ name: 'ogid-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion().name, 'ogid-readonly');
    const { tools } = await client.listTools();
    assert.equal(tools.length, 10);
    assert.ok(!tools.some(t => t.name === 'ogid_operator'));
    const legacy = ['ogid_get_awareness', 'ogid_get_awareness_sources', 'ogid_get_news', 'ogid_health'];
    assert.ok(legacy.every(name => tools.some(t => t.name === name)));
    for (const tool of tools) {
      assert.equal(tool.annotations.readOnlyHint, true);
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.ok(tool.outputSchema);
      if (!legacy.includes(tool.name)) continue;
      const result = await client.callTool({ name: tool.name, arguments: {} });
      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.ok, true);
    }
    const before = requests.length;
    for (const input of [{ force: 1 }, { url: 'http://evil' }, { countries: ['ZZ'] }, { limit: 101 }, { from: 'not-iso' }]) {
      const name = input.from ? 'ogid_get_awareness' : 'ogid_get_news';
      try {
        const result = await client.callTool({ name, arguments: input });
        assert.equal(result.isError, true);
      } catch (error) { assert.match(error.message, /[Ii]nvalid|[Vv]alidation|[Uu]nrecognized|[Ss]chema/); }
    }
    assert.equal(requests.length, before);
    assert.equal(stderr, '');
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
