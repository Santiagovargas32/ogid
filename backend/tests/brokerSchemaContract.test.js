import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createInferenceBroker,inspectServerContext} from '../services/agent/broker.js';

const format={type:'json_schema',json_schema:{name:'fixture',schema:{type:'object',additionalProperties:false,required:['value'],properties:{value:{type:'string'}}}}};
test('template attestation uses the same nested schema that llama.cpp reads for generation',async()=>{
 const urls=[],body={model:'fixture',messages:[{role:'user',content:'Use the schema'}],response_format:format,reasoning_effort:'high'};
 const result=await inspectServerContext({base:'http://127.0.0.1:8080',headers:{Authorization:'Bearer fixture'},body,model:{context:8192,slots:1},fetchImpl:async(url,options)=>{
  urls.push(url);
  if(url.includes('/props?'))return Response.json({total_slots:1,default_generation_settings:{n_ctx:8192,params:{n_predict:-1,max_tokens:-1}}});
  const payload=JSON.parse(options.body);
  if(url.endsWith('/apply-template')){assert.deepEqual(payload.response_format,format);assert.equal(payload.reasoning_effort,'high');return Response.json({prompt:'actual template including response format'});}
  assert.ok(url.endsWith('/tokenize'));assert.equal(payload.content,'actual template including response format');return Response.json({tokens:[1,2,3]});
 }});
 assert.equal(result.tokens,3);assert.equal(result.context,8192);assert.equal(urls.length,3);
});
test('broker refuses the silently ignored flat schema before context inspection or upstream admission',async t=>{
 let forwarded=0,inspected=0;
 const server=createInferenceBroker({apiKey:'upstream',token:'private',manifest:{models:[]},fetchImpl:async()=>{forwarded++;throw Error('Must not forward');},contextInspector:async()=>{inspected++;throw Error('Must not inspect');}});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base='http://127.0.0.1:'+server.address().port;
 for(const response_format of [{type:'json_schema',schema:format.json_schema.schema},{type:'json_schema',json_schema:{}},{type:'json_schema',json_schema:{schema:[]}},[],{type:'unknown'}]){
  const response=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer private','Content-Type':'application/json'},body:JSON.stringify({model:'fixture',messages:[{role:'user',content:'Never infer'}],response_format})});
  assert.equal(response.status,400);assert.equal((await response.json()).error.code,'BROKER_INVALID_RESPONSE_FORMAT');
 }
 assert.equal(forwarded,0);assert.equal(inspected,0);
});
