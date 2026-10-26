import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

test('C comparison/claim/change contracts preserve frozen pagination through a real stdio MCP transport',async()=>{
  createRequire(import.meta.url)('../../../backend/tests/testSetup.cjs');
  const {createAppServer}=await import('../../../backend/server.js'),dir=mkdtempSync(join(tmpdir(),'ogid-c-stdio-'));
  const runtime=createAppServer({port:0,host:'127.0.0.1',disableBackgroundRefresh:true,storage:{enabled:true,businessEnabled:true,databasePath:join(dir,'fixture.sqlite')},news:{providers:[],rssFeeds:[]},market:{enabled:false,initialTickers:[],tickers:[],historyDir:dir}});
  const client=new Client({name:'ogid-c-fixture',version:'1'});
  try{
    await runtime.start();await runtime.app.locals.business.news.ingest(['one','two','three'].map(id=>({title:`Missile strike in Kyiv ${id}`,url:`https://reuters.com/${id}`,provider:'rss',publishedAt:new Date().toISOString()})));
    await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/index.js',import.meta.url))],env:{PATH:process.env.PATH,OGID_BASE_URL:`http://127.0.0.1:${runtime.server.address().port}`,OGID_MAX_OUTPUT_BYTES:'8192'},stderr:'pipe'}));
    const call=async(operationId,parameters={},pathParameters)=>{const r=await client.callTool({name:'ogid_query',arguments:{operationId,parameters,...(pathParameters?{pathParameters}:{})}});assert.equal(r.structuredContent.ok,true,JSON.stringify(r.structuredContent));assert.ok(Buffer.byteLength(JSON.stringify(r))<=8192);return r.structuredContent.data;};
    const groups=await call('news.comparisons'),id=groups.items[0].groupId;
    let page=await call('news.comparison',{limit:1},{id}),items=[...page.items];const upper=page.asOfSequence;
    while(page.hasMore){page=await call('news.comparison',{cursor:page.nextCursor,limit:1},{id});assert.equal(page.asOfSequence,upper);items.push(...page.items);}
    assert.equal(new Set(items.map(x=>x.articleId)).size,3);assert.ok(items.every(x=>x.claims[0].evidence.articleRevision===1));
    const claim=await call('news.claim',{}, {id:items[0].claims[0].claimId});assert.equal(claim.current,true);
    const changes=await call('news.comparison.changes');assert.equal(changes.items.length,3);assert.equal(changes.items[0].groupId,id);
  }finally{await client.close();await runtime.stop();rmSync(dir,{recursive:true,force:true});}
});
