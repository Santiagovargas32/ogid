import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { VERSION } from "../src/config.js";

// Solo imprime contadores/calidad: no vuelca titulares, eventos ni datos privados.
const env = { PATH: process.env.PATH };
for (const key of ['OGID_BASE_URL', 'OGID_TIMEOUT_MS', 'OGID_MAX_RESPONSE_BYTES', 'OGID_MAX_OUTPUT_BYTES', 'OGID_INSTRUMENT_IDS']) {
  if (process.env[key]) env[key] = process.env[key];
}
const client = new Client({ name: 'ogid-local-smoke', version: VERSION });
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/index.js', import.meta.url))], env, stderr: 'inherit' });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 4);
  console.log(JSON.stringify({ phase: 'initialize/list', server: client.getServerVersion(), tools: tools.map(t => t.name) }));
  for (const tool of tools) {
    const result = await client.callTool({ name: tool.name, arguments: tool.name === 'ogid_get_news' || tool.name === 'ogid_get_awareness' ? { limit: 3 } : {} });
    assert.ok(!result.isError, `${tool.name}: ${result.structuredContent?.error?.code || 'error'}`);
    const payload = result.structuredContent;
    console.log(JSON.stringify({ tool: tool.name, ok: payload.ok, queriedAt: payload.queriedAt,
      news: payload.data.news?.length, upcoming: payload.data.upcoming?.length, recent: payload.data.recent?.length,
      sources: payload.data.sources?.length, awarenessMode: payload.data.mode || payload.data.awarenessMode,
      quality: payload.data.meta?.dataQuality || payload.data.quality || payload.data.dataQuality,
      truncated: payload.truncated, warnings: payload.warnings.length }));
  }
} finally { await client.close(); }
