import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { VERSION } from "../src/config.js";

// Solo imprime contadores/calidad: no vuelca titulares, eventos ni datos privados.
const env = { PATH: process.env.PATH };
for (const key of ['OGID_BASE_URL', 'OGID_TIMEOUT_MS', 'OGID_MAX_RESPONSE_BYTES', 'OGID_MAX_OUTPUT_BYTES', 'OGID_INSTRUMENT_IDS', 'OGID_INSTRUMENT_AUTH', 'OGID_MAX_CONCURRENT']) {
  if (process.env[key]) env[key] = process.env[key];
}
env.OGID_PROFILE = 'research';
const client = new Client({ name: 'ogid-local-smoke', version: VERSION });
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/index.js', import.meta.url))], env, stderr: 'inherit' });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 10);
  assert.equal(client.getServerVersion().version, VERSION);
  assert.ok(!tools.some(tool => tool.name === 'ogid_operator'));
  console.log(JSON.stringify({ phase: 'initialize/list', server: client.getServerVersion(), tools: tools.map(t => t.name) }));
  let itemId = null;
  const inputs = {
    ogid_health: {}, ogid_get_news: { limit: 3 }, ogid_get_awareness: { limit: 3 }, ogid_get_awareness_sources: {},
    ogid_get_capabilities: {}, ogid_resolve_instruments: {}, ogid_search_news: { limit: 3 },
    ogid_get_portfolio_context: { mode: 'daily', limit: 3 }, ogid_query: { operationId: 'market.watchlist', parameters: {} }
  };
  async function call(name, args) {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, `${name}: ${result.structuredContent?.error?.code || 'error'}`);
    const payload = result.structuredContent;
    console.log(JSON.stringify({ tool: name, ok: payload.ok, mode: args.mode,
      articles: payload.data.articles?.length, total: payload.data.total, hasMore: payload.data.hasMore,
      archivePartial: payload.data.coverage?.partial, instrumentCount: payload.data.instruments?.length,
      news: payload.data.news?.length, upcoming: payload.data.upcoming?.length, recent: payload.data.recent?.length,
      truncated: payload.truncated, warnings: payload.warnings.length }));
    return payload.data;
  }
  for (const [name, args] of Object.entries(inputs)) {
    const data = await call(name, args);
    if (name === 'ogid_search_news') itemId = data.articles[0]?.id;
  }
  if (itemId) await call('ogid_get_news_item', { id: itemId });
  else console.log(JSON.stringify({ tool: 'ogid_get_news_item', skipped: true, reason: 'archive-empty-no-item-to-read' }));
  for (const mode of ['agenda', 'material', 'weekly']) await call('ogid_get_portfolio_context', { mode, limit: 3 });

} finally { await client.close(); }
