import test from 'node:test';
import assert from 'node:assert/strict';
import {pressureError} from '../storage/resourceAdmission.js';
import {createAgentInternalClient} from '../services/agent/internalClient.js';
import {toolReceipt} from '../services/agent/toolReceipt.js';
import {projectAgentRunMetadata} from '../services/agent/validationMetadata.js';
import {createReadClient} from '../../integrations/ogid-mcp/src/client.js';
import {loadConfig} from '../../integrations/ogid-mcp/src/config.js';
import {executeTool,toolDefinitions} from '../../integrations/ogid-mcp/src/tools.js';

const sample={state:'degraded',critical:true,reason:'io-pressure',availableBytes:2147483648,memoryFull:1.5,ioFull:54,sampledAt:100000,ageMs:0,apiKey:'PRIVATE',path:'/private/secret'};
test('pressure diagnostics survive HTTP and MCP receipt without reflecting private error fields',async()=>{
 const failure=pressureError(sample);assert.equal(failure.details.notExecuted,true);
 let reads=0;const response=async()=>{reads++;return Response.json({error:{code:failure.code,details:{...failure.details,apiKey:'PRIVATE'}}},{status:503});};
 const internal=createAgentInternalClient({baseUrl:'http://127.0.0.1:3000',token:'fixture',fetchImpl:response});
 await assert.rejects(internal('evidence'),e=>e.causeCode===failure.code&&e.notExecuted&&e.details.ioFull===54);assert.equal(reads,1);
 const config=loadConfig({OGID_RESEARCH_SCOPE:'agent-evidence'}),mcp=createReadClient(config,response);
 const tool=toolDefinitions(config,mcp).find(t=>t.name==='ogid_agent_evidence');
 const envelope=await executeTool(tool,{snapshotId:'frozen'},config);
 assert.equal(reads,3,'keep the existing single read retry');
 assert.equal(envelope.isError,true);
 const receipt=toolReceipt(envelope);
 const durable=projectAgentRunMetadata({lastToolFailure:{code:receipt.applicationCode,resourcePressure:receipt.resourcePressure}});
 assert.equal(durable.lastToolFailure.resourcePressure.availableBytes,2147483648);
 assert.equal(durable.lastToolFailure.resourcePressure.ioFull,54);
 assert.equal(JSON.stringify(durable).includes('PRIVATE'),false);
 assert.equal(JSON.stringify(durable).includes('/private'),false);
});
test('untrusted pressure fields never become metric values or oversized reasons',()=>{
 const receipt=toolReceipt({ok:false,error:{code:'STORAGE_RESOURCE_PRESSURE',details:{state:'made-up',critical:'true',reason:'x'.repeat(100000),ioFull:Infinity,memoryFull:101,availableBytes:-1,notExecuted:true}}});
 assert.deepEqual(receipt.resourcePressure,{notExecuted:true});
});
