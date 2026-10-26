import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {createAppServer} from '../server.js';
import {createReadClient} from '../../integrations/ogid-mcp/src/client.js';
import {loadConfig} from '../../integrations/ogid-mcp/src/config.js';
import {toolDefinitions,executeTool} from '../../integrations/ogid-mcp/src/tools.js';
import {storageOperationContract} from '../contracts/storageOperations.js';

test('C uses real writer/readonly query lanes, authenticated audit and bounded MCP detail without losing claims',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ogid-comparison-http-')),databasePath=join(dir,'fixture.sqlite'),token='fixture_comparison_'+'k'.repeat(40);
  const runtime=createAppServer({port:0,host:'127.0.0.1',disableBackgroundRefresh:true,storage:{enabled:true,businessEnabled:true,databasePath},security:{allowLocalAdmin:false,adminApiToken:''},mcpOperatorCredentials:[{token,scopes:['news:comparisons:write']}],news:{providers:[],rssFeeds:[]},market:{enabled:false,initialTickers:[],tickers:[],historyDir:dir}});
  try{
    await runtime.start();const baseUrl=`http://127.0.0.1:${runtime.server.address().port}`,config=loadConfig({OGID_BASE_URL:baseUrl}),read=createReadClient(config),operator=createReadClient({...config,profile:'operator',operatorCredential:{token,scopes:['news:comparisons:write']}});
    const now=new Date().toISOString();await runtime.app.locals.business.news.ingest(['a','b','c'].map(id=>({id,title:`Missile strike in Kyiv ${id}`,url:`https://reuters.com/${id}`,provider:'rss',publishedAt:now})));
    const list=await read.operation('news.comparisons');assert.equal(list.items.length,1);const groupId=list.items[0].groupId;assert.equal(list.items[0].summary.publications,3);
    const tool=toolDefinitions(config,read).find(t=>t.name==='ogid_query');
    const result=await executeTool(tool,{operationId:'news.comparison',parameters:{limit:1,maxBytes:8192},pathParameters:{id:groupId}},{...config,maxOutputBytes:8192});
    assert.ok(!result.isError,JSON.stringify(result));assert.ok(Buffer.byteLength(JSON.stringify(result))<=8192);assert.equal(result.structuredContent.data.items[0].claims[0].evidence.articleRevision,1);assert.equal(result.structuredContent.data.hasMore,true);
    const item=result.structuredContent.data.items[0],input={requestId:'source-proof',action:'origin',articleIds:[item.articleId],originChainId:'explicit-wire-proof',reviewer:'Fixture operator',reason:'Explicit article attribution in fixture',references:['https://example.org/proof']};
    await runtime.app.locals.business.news.ingest([{title:'Missile strike in Kyiv '+String.raw`\"`.repeat(150),url:'https://reuters.com/escaped',provider:'rss',publishedAt:now}]);
    for(const maxOutputBytes of [4096,8192,16384,65536]){
      let cursor,seen=[];
      do{
        const output=await executeTool(tool,{operationId:'news.comparison',parameters:{limit:100,maxBytes:maxOutputBytes,...(cursor?{cursor}:{})},pathParameters:{id:groupId}},{...config,maxOutputBytes});
        assert.ok(Buffer.byteLength(JSON.stringify(output))<=maxOutputBytes);
        if(output.isError){assert.equal(output.structuredContent.error.code,'COMPARISON_ROW_TOO_LARGE');break;}
        seen.push(...output.structuredContent.data.items);cursor=output.structuredContent.data.nextCursor;
      }while(cursor);
      if(maxOutputBytes>=16384)assert.equal(new Set(seen.map(x=>x.articleId)).size,4);
    }
    await assert.rejects(read.operation('news.comparison.review',{},input),{code:'FORBIDDEN_REQUEST'});
    assert.equal((await fetch(`${baseUrl}/api/admin/news/comparisons/review`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)})).status,401);
    const reviewed=await operator.operation('news.comparison.review',{},input);assert.deepEqual(await operator.operation('news.comparison.review',{},input),reviewed);
    const claim=await read.operation('news.claim',{},undefined,{id:item.claims[0].claimId});assert.equal(claim.current,true);
    const changes=await read.operation('news.comparison.changes');assert.equal(changes.items.at(-1).reviewId,reviewed.reviewId);
    for(const method of ['comparisons','comparison','comparisonClaim','comparisonChanges'])assert.equal(storageOperationContract('domain.call',{service:'news',method}).role,'queries');
    const db=new Database(databasePath,{readonly:true});db.pragma('query_only=ON');assert.equal(db.prepare('SELECT count(*) AS n FROM news_comparison_reviews').get().n,1);assert.equal(db.prepare("SELECT count(*) AS n FROM storage_commands WHERE request_id='source-proof'").get().n,1);db.close();
    assert.equal((await fetch(`${baseUrl}/comparisons.html`)).status,200);
  }finally{await runtime.stop();rmSync(dir,{recursive:true,force:true});}
});
