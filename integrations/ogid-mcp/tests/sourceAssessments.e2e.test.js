import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

test('source assessments traverse real stdio, SQLite operator import and bounded reader output',async()=>{
  createRequire(import.meta.url)('../../../backend/tests/testSetup.cjs');
  const {createAppServer}=await import('../../../backend/server.js');
  const dir=mkdtempSync(join(tmpdir(),'ogid-mcp-assessment-')),token='fictional_assessment_'+'x'.repeat(40),credentialPath=join(dir,'operator.json');
  writeFileSync(credentialPath,JSON.stringify({token,scopes:['news:assessments:write']}),{mode:0o600});
  const runtime=createAppServer({port:0,host:'127.0.0.1',disableBackgroundRefresh:true,storage:{enabled:true,businessEnabled:true,databasePath:join(dir,'fixture.sqlite')},security:{allowLocalAdmin:false,adminApiToken:''},mcpOperatorCredentials:[{token,scopes:['news:assessments:write']}],news:{providers:[],rssFeeds:[]},market:{enabled:false,initialTickers:[],tickers:[],historyDir:dir}});
  const research=new Client({name:'source-fixture-reader',version:'1'}),operator=new Client({name:'source-fixture-operator',version:'1'});
  try{
    await runtime.start();const env={PATH:process.env.PATH,OGID_BASE_URL:`http://127.0.0.1:${runtime.server.address().port}`,OGID_MAX_OUTPUT_BYTES:'8192'};
    const transport=extra=>new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/index.js',import.meta.url))],env:{...env,...extra},stderr:'pipe'});
    await research.connect(transport({}));await operator.connect(transport({OGID_PROFILE:'operator',OGID_OPERATOR_CREDENTIAL_FILE:credentialPath}));
    const query=parameters=>research.callTool({name:'ogid_query',arguments:{operationId:'news.source-assessments',parameters:{publisherIds:['reuters'],...parameters}}});
    const initial=await query({});assert.equal(initial.structuredContent.data.items[0].status,'unrated');
    const at=new Date().toISOString(),body={requestId:'stdio-preview',permission:{basis:'self-authored',reference:'Fictional transport fixture; no real evaluation',redistributionAllowed:true},assessments:[{assessmentId:'stdio-fictional',revision:1,publisherId:'reuters',edition:'reuters.com',evaluatorId:'fictional-evaluator',evaluatorName:'Fictional evaluator',politicalScope:'fixture-only',methodId:'fictional-method',methodVersion:'1',methodUrl:'https://example.org/fixture',originalRating:'fictional-label',rating:'unmapped',scaleVersion:'external-unmapped',assessedAt:at,validFrom:at,state:'published',evidenceUrls:['https://example.org/evidence'],licenseName:'Fictional self-authored fixture',licenseUrl:'https://example.org/permission'}]};
    const preview=await operator.callTool({name:'ogid_operator',arguments:{operationId:'news.source-assessments.import',body}});assert.ok(!preview.isError,JSON.stringify(preview));assert.equal(preview.structuredContent.data.dryRun,true);
    const committed=await operator.callTool({name:'ogid_operator',arguments:{operationId:'news.source-assessments.import',body:{...body,requestId:'stdio-commit',dryRun:false}}});assert.ok(!committed.isError);assert.equal(committed.structuredContent.data.inserted,1);
    const records=await query({view:'records'});assert.ok(!records.isError,JSON.stringify(records));assert.equal(records.structuredContent.data.items[0].originalRating,'fictional-label');assert.ok(Buffer.byteLength(JSON.stringify(records))<=8192);
    const detail=await research.callTool({name:'ogid_query',arguments:{operationId:'news.source-assessment',parameters:{revision:1},pathParameters:{id:'stdio-fictional'}}});assert.equal(detail.structuredContent.data.assessment.evidenceUrls[0],body.assessments[0].evidenceUrls[0]);
    const missing=await research.callTool({name:'ogid_query',arguments:{operationId:'news.source-assessment',pathParameters:{id:'absent'}}});assert.equal(missing.structuredContent.error.code,'SOURCE_ASSESSMENT_NOT_FOUND');
  }finally{await research.close();await operator.close();await runtime.stop();rmSync(dir,{recursive:true,force:true});}
});
