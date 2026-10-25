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

test('agent evidence chunk traverses real stdio with selected validation and an application receipt',async()=>{
  const requests=[];
  const server=createServer((req,res)=>{requests.push(req.url);res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,data:{snapshotId:'snapshot-fixture',evidenceId:'technical-fixture',encoding:'utf8',chunk:'{"data":{"rsi":42}}',sha256:'0'.repeat(64),bytes:19,nextOffset:19,hasMore:false}}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/index.js',import.meta.url))],env:{PATH:process.env.PATH,OGID_BASE_URL:`http://127.0.0.1:${server.address().port}`,OGID_RESEARCH_SCOPE:'agent-evidence'},stderr:'pipe'});
  transport.stderr.on('data',()=>{});const client=new Client({name:'chunk-regression',version:'1'});
  try{
    await client.connect(transport);
    const good=await client.callTool({name:'ogid_query',arguments:{operationId:'agent.evidence.chunk',parameters:{snapshotId:'snapshot-fixture',evidenceId:'technical-fixture',format:'utf8'}}});
    assert.equal(good.isError,undefined);assert.equal(good.structuredContent.readReceipt.contentRead,true);assert.equal(good.structuredContent.readReceipt.contractHash.length,64);
    assert.equal(requests.length,1);assert.match(requests[0],/^\/api\/agent\/v1\/evidence\/chunk\?/);
    const bad=await client.callTool({name:'ogid_query',arguments:{operationId:'agent.evidence.chunk',parameters:{snapshotId:'snapshot-fixture',evidenceId:42,secret:'PRIVATE'}}});
    assert.equal(bad.isError,true);assert.equal(bad.structuredContent.error.details.stage,'operation-parameters');assert.ok(bad.structuredContent.error.details.issues.length<=16);assert.ok(!JSON.stringify(bad).includes('PRIVATE'));assert.equal(requests.length,1);
    const typed=await client.callTool({name:'ogid_agent_evidence_chunk',arguments:{snapshotId:'snapshot-fixture',evidenceId:'technical-fixture',format:'utf8'}});
    assert.equal(typed.structuredContent.readReceipt.operationId,'agent.evidence.chunk');assert.equal(typed.structuredContent.readReceipt.contentRead,true);
    const listed=(await client.listTools()).tools.find(t=>t.name==='ogid_agent_evidence_chunk');assert.equal(listed.inputSchema.properties.snapshotId.type,'string');
    for(const snapshotId of [{'$ref':'PRIVATE'},{'$type':'string',value:'PRIVATE'},{'$oid':'PRIVATE'},{},42]){
      const rejected=await client.callTool({name:'ogid_agent_evidence_chunk',arguments:{snapshotId,evidenceId:'technical-fixture'}});
      assert.equal(rejected.isError,true);assert.equal(rejected.structuredContent.error.code,'INVALID_ARGUMENTS');assert.equal(rejected.structuredContent.identity.hash,typed.structuredContent.identity.hash);assert.ok(!JSON.stringify(rejected).includes('PRIVATE'));
    }
    assert.equal(requests.length,2);
    for(const input of [
      {snapshotId:'snapshot-fixture',evidenceId:'technical-fixture',offset:'0'},
      {snapshotId:'snapshot-fixture',evidenceId:'technical-fixture',offset:.5},
      {snapshotId:'snapshot-fixture',evidenceId:'technical-fixture',format:'json'},
      {snapshotId:'snapshot-fixture',evidenceId:'technical-fixture',operationId:'agent.evidence',secret:'PRIVATE'},
    ]){
      const rejected=await client.callTool({name:'ogid_agent_evidence_chunk',arguments:input});assert.equal(rejected.isError,true);assert.ok(!JSON.stringify(rejected).includes('PRIVATE'));
    }
    for(const input of [{snapshotId:'snapshot-fixture',domain:{$type:'string'}},{snapshotId:'snapshot-fixture',domain:'coverage',limit:'10'},{snapshotId:'snapshot-fixture',limit:1.5}])assert.equal((await client.callTool({name:'ogid_agent_evidence',arguments:input})).isError,true);
    assert.equal((await client.callTool({name:'ogid_agent_clusters',arguments:{snapshotId:'snapshot-fixture',domain:'coverage'}})).isError,true);
    assert.equal(requests.length,2,'all typed rejections happen before HTTP');
  }finally{await client.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
