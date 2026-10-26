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

test('real SQLite readers and operator import expose bounded MCP records, permissions and durable replay',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ogid-assessment-http-')),databasePath=join(dir,'fixture.sqlite'),token='fixture_source_operator_'+'k'.repeat(40);
  const runtime=createAppServer({port:0,host:'127.0.0.1',disableBackgroundRefresh:true,storage:{enabled:true,businessEnabled:true,databasePath},security:{allowLocalAdmin:false,adminApiToken:''},mcpOperatorCredentials:[{token,scopes:['news:assessments:write']}],news:{providers:[],rssFeeds:[]},market:{enabled:false,initialTickers:[],tickers:[],historyDir:dir}});
  try{
    await runtime.start();const baseUrl=`http://127.0.0.1:${runtime.server.address().port}`,config=loadConfig({OGID_BASE_URL:baseUrl});
    const read=createReadClient(config),operatorConfig={...config,profile:'operator',operatorCredential:{token,scopes:['news:assessments:write']}},operator=createReadClient(operatorConfig);
    const now=new Date().toISOString(),body={requestId:'preview-fixture',permission:{basis:'self-authored',reference:'Fictional fixture: no real editorial assessment',redistributionAllowed:true},assessments:[{assessmentId:'fictional-integration',revision:1,publisherId:'reuters',edition:'reuters.com',evaluatorId:'fictional-evaluator',evaluatorName:'Fictional integration evaluator',politicalScope:'fictional-test-only',methodId:'fictional-method',methodVersion:'1',methodUrl:'https://example.org/fixture-method',originalRating:'fictional-unmapped',rating:'unmapped',scaleVersion:'external-unmapped',assessedAt:now,validFrom:now,state:'published',evidenceUrls:['https://example.org/fixture-evidence'],licenseName:'Fictional self-authored test',licenseUrl:'https://example.org/fixture-permission'}]};
    let page=await read.operation('news.source-assessments',{publisherIds:['reuters']});assert.equal(page.items[0].status,'unrated');
    await assert.rejects(read.operation('news.source-assessments.import',{},body),{code:'FORBIDDEN_REQUEST'});
    const denied=await fetch(`${baseUrl}/api/admin/news/source-assessments/import`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(denied.status,401);
    const preview=await operator.operation('news.source-assessments.import',{},body);assert.equal(preview.dryRun,true);
    assert.equal((await read.operation('news.source-assessments',{publisherIds:['reuters']})).items[0].status,'unrated');
    const actual={...body,requestId:'commit-fixture',dryRun:false};assert.equal((await operator.operation('news.source-assessments.import',{},actual)).inserted,1);
    assert.deepEqual(await operator.operation('news.source-assessments.import',{},actual),await operator.operation('news.source-assessments.import',{},actual));
    page=await read.operation('news.source-assessments',{publisherIds:['reuters'],view:'records',limit:1,maxBytes:8192});assert.equal(page.items[0].assessmentId,'fictional-integration');
    const detail=await read.operation('news.source-assessment',{},undefined,{id:'fictional-integration'});assert.equal(detail.assessment.licenseName,body.assessments[0].licenseName);
    const tool=toolDefinitions(config,read).find(t=>t.name==='ogid_query');const result=await executeTool(tool,{operationId:'news.source-assessments',parameters:{publisherIds:['reuters'],view:'records',maxBytes:8192}}, {...config,maxOutputBytes:8192});
    assert.ok(!result.isError,JSON.stringify(result));assert.ok(Buffer.byteLength(JSON.stringify(result))<=8192);assert.equal(result.structuredContent.data.items[0].usagePermission.reference,body.permission.reference);
    const coverage=await read.operation('news.source-coverage');assert.equal(coverage.summary.articles,0);
    for(const method of ['sourceAssessments','sourceAssessment','sourceCoverage'])assert.equal(storageOperationContract('domain.call',{service:'news',method}).role,'queries');
    const db=new Database(databasePath,{readonly:true});db.pragma('query_only=ON');assert.equal(db.prepare('SELECT count(*) AS n FROM news_source_assessments').get().n,1);assert.equal(db.prepare("SELECT count(*) AS n FROM storage_commands WHERE request_id='commit-fixture'").get().n,1);assert.throws(()=>db.exec('DELETE FROM news_source_assessments'));db.close();
    assert.equal((await fetch(`${baseUrl}/sources.html`)).status,200);
  }finally{await runtime.stop();rmSync(dir,{recursive:true,force:true});}
});
