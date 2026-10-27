import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

test('D traverses real MCP stdio with AI off, exact evidence, operator permissions and correction propagation',async()=>{
 createRequire(import.meta.url)('../../../backend/tests/testSetup.cjs');
 const {createAppServer}=await import('../../../backend/server.js'),dir=mkdtempSync(join(tmpdir(),'ogid-d-stdio-'));
 const token='situation_fixture_'+'x'.repeat(48),credential=join(dir,'operator.json');writeFileSync(credential,JSON.stringify({token,scopes:['situations:write']}),{mode:0o600});
 const runtime=createAppServer({port:0,host:'127.0.0.1',disableBackgroundRefresh:true,agent:{mode:'off'},storage:{enabled:true,businessEnabled:true,databasePath:join(dir,'fixture.sqlite')},security:{allowLocalAdmin:false,adminApiToken:''},mcpOperatorCredentials:[{token,scopes:['situations:write']}],news:{providers:[],rssFeeds:[]},market:{enabled:false,initialTickers:[],tickers:[],historyDir:dir}});
 const research=new Client({name:'situations-reader',version:'1'}),operator=new Client({name:'situations-reviewer',version:'1'});
 try{
  await runtime.start();assert.equal(runtime.app.locals.agentConfig.mode,'off');assert.equal(runtime.app.locals.agentMaintenance.enabled,true);
  const base=`http://127.0.0.1:${runtime.server.address().port}`,env={PATH:process.env.PATH,OGID_BASE_URL:base,OGID_MAX_OUTPUT_BYTES:'32768'};
  const transport=extra=>new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/index.js',import.meta.url))],env:{...env,...extra},stderr:'pipe'});
  await research.connect(transport({}));await operator.connect(transport({OGID_PROFILE:'operator',OGID_OPERATOR_CREDENTIAL_FILE:credential}));
  const read=async(operationId,parameters={},pathParameters)=>{const r=await research.callTool({name:'ogid_query',arguments:{operationId,parameters,...(pathParameters?{pathParameters}:{})}});assert.equal(r.structuredContent.ok,true,JSON.stringify(r.structuredContent));assert.ok(Buffer.byteLength(JSON.stringify(r))<=32768);return r.structuredContent.data;};
  await runtime.app.locals.business.news.ingest([{title:'Missile strike in Kyiv <img src=x onerror=alert(1)>',url:'https://reuters.com/d-fixture',provider:'rss',publishedAt:new Date().toISOString()}]);
  assert.equal((await read('situations.status')).hasMore,true);await runtime.app.locals.agentCall('alertSync',{limit:100,budgetMs:100});
  const groups=await read('situations.list',{limit:1,maxBytes:16384});assert.equal(groups.items.length,1);assert.equal(groups.items[0].occurredAt,null);
  const detail=await read('situations.detail',{limit:1,maxBytes:16384},{id:groups.items[0].id});assert.equal(detail.items.length,1);assert.ok(detail.items[0].claimReferences[0].claimId);
  const body={requestId:'stdio-incident',action:'create-incident',entityId:detail.entity.id,title:'Reported source claim',reviewer:'Fixture operator',reason:'Explicit association with exact publication evidence',references:['https://example.org/review'],sourceRefs:[{stream:'news',sourceId:detail.items[0].sourceId,sourceRevision:detail.items[0].sourceRevision}]};
  const reviewed=await operator.callTool({name:'ogid_operator',arguments:{operationId:'situations.review',body}});assert.equal(reviewed.structuredContent.ok,true,JSON.stringify(reviewed.structuredContent));
  const replay=await operator.callTool({name:'ogid_operator',arguments:{operationId:'situations.review',body}});assert.deepEqual(replay.structuredContent.data,reviewed.structuredContent.data);
  const incidentId=reviewed.structuredContent.data.id,incident=await read('situations.detail',{maxBytes:16384},{id:incidentId});assert.equal(incident.entity.currentness.current,true);
  const denied=await fetch(base+'/api/admin/situations/review',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,requestId:'unauthorized'})});assert.equal(denied.status,401);
  await runtime.app.locals.business.news.ingest([{title:'No missile strike in Kyiv',url:'https://reuters.com/d-fixture',provider:'rss',publishedAt:new Date().toISOString()}]);
  await runtime.app.locals.agentCall('alertSync',{limit:100,budgetMs:100});
  const corrected=await read('situations.detail',{maxBytes:16384},{id:incidentId});assert.equal(corrected.entity.verification,'needs-review');assert.equal(corrected.entity.id,incidentId);
  const frozen=await read('situations.detail',{atSequence:incident.asOfSequence,maxBytes:16384},{id:incidentId});assert.equal(frozen.entity.currentness.current,true);
  const changes=await read('situations.changes',{limit:1,maxBytes:8192});assert.ok(changes.hasMore);const next=await read('situations.changes',{limit:1,maxBytes:8192,cursor:changes.nextCursor});assert.equal(next.asOfSequence,changes.asOfSequence);assert.notEqual(next.items[0].sequence,changes.items[0].sequence);
  const history=await read('situations.revisions',{maxBytes:16384},{id:groups.items[0].id});assert.ok(history.items.length>=2);
  const missing=await research.callTool({name:'ogid_query',arguments:{operationId:'situations.detail',pathParameters:{id:'missing'}}});assert.equal(missing.structuredContent.error.code,'SITUATION_NOT_FOUND');
 }finally{await research.close();await operator.close();await runtime.stop();rmSync(dir,{recursive:true,force:true});}
});
