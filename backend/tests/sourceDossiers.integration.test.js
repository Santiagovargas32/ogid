import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createAppServer} from '../server.js';
import {dossier} from './fixtures/sourceDossier.js';
import {createReadClient} from '../../integrations/ogid-mcp/src/client.js';
import {loadConfig} from '../../integrations/ogid-mcp/src/config.js';

test('real writer/query lanes and MCP keep drafts private and publish only a reviewed hash',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'source-evaluations-http-')),token='fixture_'+ 'k'.repeat(48);
 const runtime=createAppServer({port:0,host:'127.0.0.1',disableBackgroundRefresh:true,storage:{enabled:true,businessEnabled:true,databasePath:join(dir,'db.sqlite')},news:{providers:[],rssFeeds:[]},market:{enabled:false,provider:'',historyPersist:false,tickers:[]},mcpOperatorCredentials:[{token,scopes:['news:assessments:write']}]});
 try{
  await runtime.start();const baseUrl='http://127.0.0.1:'+runtime.server.address().port;
  const config={...loadConfig({}),baseUrl,profile:'operator',operatorCredential:{token,scopes:['news:assessments:write']}};const read=createReadClient(config);
  const d=dossier(),now=new Date().toISOString();d.asOf=now;d.validFrom=now;d.profile.verifiedAt=now;d.evidence[0].retrievedAt=now;
  const proposal=await read.operation('news.source-evaluations.propose',{}, {requestId:'proposal',dossier:d});
  assert.equal((await read.operation('news.source-evaluations',{})).items.length,0);
  assert.equal((await read.operation('news.source-evaluations.pending',{})).items[0].contentHash,proposal.contentHash);
  const forbidden=await fetch(baseUrl+'/api/admin/news/source-evaluations');assert.equal(forbidden.status,403);
  const review={requestId:'review',dossierId:d.dossierId,revision:1,contentHash:proposal.contentHash,decision:'approve',reviewer:'Human fixture',reason:'Controlled test only'};
  const result=await read.operation('news.source-evaluations.review',{},review);assert.equal(result.decision,'approve');assert.deepEqual(await read.operation('news.source-evaluations.review',{},review),result);
  const published=await read.operation('news.source-evaluations',{});assert.equal(published.items[0].sampleSize,0);assert.equal(published.items[0].political.rating,null);
  const detail=await read.operation('news.source-evaluation',{section:'evidence'},undefined,{id:d.dossierId});assert.equal(detail.items[0].id,'policy');
  assert.equal((await read.operation('news.source-assessments',{publisherIds:['reuters']})).items[0].ownEvaluation.dossierId,d.dossierId);
 }finally{await runtime.stop();rmSync(dir,{recursive:true,force:true});}
});
