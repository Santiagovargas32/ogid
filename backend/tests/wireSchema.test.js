import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {compileWireSchema} from '../services/agent/wireSchema.js';
import {generationSchemaForJob,generationExample,validateGeneratedPublication} from '../services/agent/briefReports.js';
import {PROMPT_VERSION} from '../services/agent/contracts.js';
import {stableHash} from '../utils/stableHash.js';
const ajv=new Ajv({allErrors:true,strict:false});
const job=task=>({task,scope:task==='instrument_outlook'?'NVDA':task==='situation_analysis'?'situation:fixture':'global',promptVersion:PROMPT_VERSION});
const tasks=['global_intelligence_brief','market_outlook_global','instrument_outlook','geopolitical_alert_assessment','situation_analysis'];
const clone=value=>JSON.parse(JSON.stringify(value));
function restore({schema,postValidationOnly}){
 const restored=clone(schema);
 for(const row of postValidationOnly){
  const parts=row.path.slice(1).split('/').map(key=>key.replace(/~1/g,'/').replace(/~0/g,'~'));
  const keyword=parts.pop(),parent=parts.reduce((value,key)=>value[key],restored);
  assert.equal(keyword,row.keyword);parent[keyword]=clone(row.value);
 }
 return restored;
}

test('canonical examples for all five structured modalities remain valid under the wire over-approximation',()=>{
 for(const task of tasks){
  const j=job(task),canonical=generationSchemaForJob(j),compiled=compileWireSchema(canonical),value=generationExample(j,'coverage:fixture');
  assert.equal(ajv.compile(canonical)(value),true,task+' canonical');assert.equal(ajv.compile(compiled.schema)(value),true,task+' wire');
  assert.equal(validateGeneratedPublication(value,j),true);assert.equal(compiled.version,'ogid-wire-schema-v1');
 }
});

test('required fields, types, enum/const, probability and maxItems=0 restrictions survive compilation',()=>{
 for(const task of tasks){
  const j=job(task),compiled=compileWireSchema(generationSchemaForJob(j)),validate=ajv.compile(compiled.schema),base=generationExample(j,'coverage:fixture');
  for(const field of ['task','evidenceIds','narrativeFacts'])assert.equal(validate({...base,[field]:null}),false,task+' '+field);
  const missing={...base};delete missing.task;assert.equal(validate(missing),false);
  assert.equal(validate({...base,task:'unknown-task'}),false);assert.equal(validate({...base,probability:0.5}),false);
  assert.equal(validate({...base,probability:null}),true);
 }
 const j=job('global_intelligence_brief'),compiled=compileWireSchema(generationSchemaForJob(j)),validate=ajv.compile(compiled.schema),base=generationExample(j,'coverage:fixture');
 assert.equal(compiled.schema.properties.narrativeFacts.maxItems,0);assert.equal(compiled.schema.properties.technicalFacts.maxItems,0);
 assert.equal(compiled.schema.allOf[0].if.properties.sourceReports.maxItems,0);
 assert.equal(validate({...base,narrativeFacts:[{kind:'coverage',field:'/limitations/0',literal:'one',evidenceId:'coverage:fixture',path:'value'}]}),false);
});

test('oversized text and arrays may pass the grammar schema but canonical post-validation still rejects them',()=>{
 const j=job('market_outlook_global'),canonical=generationSchemaForJob(j),validate=ajv.compile(compileWireSchema(canonical).schema),base=generationExample(j,'coverage:fixture');
 const fact={kind:'coverage',field:'/limitations/0',literal:'x',evidenceId:'coverage:fixture',path:'value'};
 for(const value of [{...base,narrativeFacts:[{...fact,literal:'x'.repeat(257)}]},{...base,narrativeFacts:Array.from({length:101},()=>({...fact}))}]){
  assert.equal(validate(value),true);assert.equal(ajv.compile(canonical)(value),false);assert.equal(validateGeneratedPublication(value,j),false);
 }
});

test('only audited repetition maxima change; canonical schemas and shared definitions retain their original hashes',()=>{
 for(const task of tasks){
  const canonical=generationSchemaForJob(job(task)),before=stableHash(canonical),compiled=compileWireSchema(canonical);
  assert.equal(stableHash(canonical),before);assert.deepEqual(restore(compiled),canonical);
  assert.ok(compiled.postValidationOnly.every(row=>row.keyword==='maxLength'||row.keyword==='maxItems'&&row.value>0));
  assert.deepEqual(compileWireSchema(canonical),compiled);
  compiled.schema.properties.task={const:'mutated'};assert.equal(stableHash(canonical),before);
 }
 const shared={type:'string',maxLength:3},canonical={type:'object',properties:{a:shared,b:shared}};
 const compiled=compileWireSchema(canonical);assert.deepEqual(compiled.postValidationOnly.map(row=>row.path),['/properties/a/maxLength','/properties/b/maxLength']);assert.equal(shared.maxLength,3);assert.deepEqual(restore(compiled),canonical);
});

test('schema pointers escape names and traversal does not alter annotation, enum, const or default data',()=>{
 const canonical={type:'object',properties:{maxLength:{type:'string',maxLength:4},'a/b~c':{type:'array',maxItems:3,items:{type:'string',maxLength:8}}},required:['maxLength'],
  const:{maxLength:4,maxItems:3},enum:[{maxLength:4,maxItems:3}],default:{maxLength:4},examples:[{maxItems:3}],description:'maxLength remains canonical',customAnnotation:{maxLength:1},
  allOf:[{if:{properties:{maxLength:{maxLength:2}}},then:{properties:{'a/b~c':{maxItems:0}}},else:{properties:{'a/b~c':{maxItems:2}}}}]};
 const compiled=compileWireSchema(canonical);assert.deepEqual(restore(compiled),canonical);
 assert.ok(compiled.postValidationOnly.some(row=>row.path==='/properties/a~1b~0c/items/maxLength'));
 for(const key of ['const','enum','default','examples','description','customAnnotation','required'])assert.deepEqual(compiled.schema[key],canonical[key]);
 assert.equal(compiled.schema.allOf[0].then.properties['a/b~c'].maxItems,0);
});

test('nested schema maps, tuple schemas, dependencies and boolean schemas remain independently reproducible',()=>{
 const canonical={$defs:{part:{type:'string',maxLength:4}},definitions:{old:{type:'array',maxItems:2}},patternProperties:{'^a':{type:'string',maxLength:6}},
  dependentSchemas:{a:{properties:{b:{maxLength:2}}}},dependencies:{a:['b'],b:{maxItems:4}},items:[{maxLength:2},false],prefixItems:[{maxLength:3}],
  additionalProperties:{maxLength:9},not:{maxItems:0},anyOf:[{maxLength:1}],oneOf:[{maxItems:2}],contains:{maxLength:7}};
 const compiled=compileWireSchema(canonical);assert.deepEqual(restore(compiled),canonical);assert.deepEqual(compiled.schema.dependencies.a,['b']);assert.equal(compiled.schema.not.maxItems,0);
 for(const value of [true,false])assert.deepEqual(compileWireSchema(value),{schema:value,postValidationOnly:[],version:'ogid-wire-schema-v1'});
 for(const value of [null,[],1,'schema'])assert.throws(()=>compileWireSchema(value),TypeError);
});

test('negation, conditional predicates and exclusive choices retain their maxima and canonical accepted instances',()=>{
 const schemas=[
  {type:'string',not:{maxLength:2}},
  {type:'object',required:['value','tag'],properties:{value:{type:'string'},tag:{type:'string'}},if:{properties:{value:{maxLength:2}}},then:{properties:{tag:{const:'short'}}},else:{properties:{tag:{const:'long'}}}},
  {type:'string',oneOf:[{maxLength:2},{minLength:3,maxLength:4}]},
  {type:'array',not:{maxItems:2}}
 ];
 const instances=[['a','abc'],[{value:'a',tag:'short'},{value:'abc',tag:'long'},{value:'abc',tag:'short'}],['a','abc','abcde'],[[],[1,2,3]]];
 for(const [index,canonical]of schemas.entries()){
  const compiled=compileWireSchema(canonical),original=ajv.compile(canonical),wire=ajv.compile(compiled.schema);
  assert.deepEqual(compiled.schema,canonical);assert.deepEqual(compiled.postValidationOnly,[]);
  for(const value of instances[index])assert.equal(wire(value),original(value));
 }
 // Bounds in result branches may still be relaxed with the predicate fixed.
 const conditional={type:'string',if:{maxLength:2},then:{maxLength:1},else:{maxLength:4}};
 const compiled=compileWireSchema(conditional);assert.equal(compiled.schema.if.maxLength,2);assert.equal(compiled.schema.then.maxLength,undefined);assert.equal(compiled.schema.else.maxLength,undefined);
 assert.ok(compiled.postValidationOnly.every(row=>!row.path.startsWith('/if/')));
});

test('references are preserved conservatively, including definitions reached under a negative context',()=>{
 const canonical={type:'string',$defs:{small:{type:'string',maxLength:2}},not:{$ref:'#/$defs/small'}};
 const compiled=compileWireSchema(canonical);assert.deepEqual(compiled.schema,canonical);assert.deepEqual(compiled.postValidationOnly,[]);
 const original=ajv.compile(canonical),wire=ajv.compile(compiled.schema);for(const value of ['a','abc'])assert.equal(wire(value),original(value));
 for(const keyword of ['$dynamicRef','$recursiveRef']){const value={type:'string',maxLength:4,[keyword]:'#'};assert.deepEqual(compileWireSchema(value).schema,value);}
});

test('contains with an upper match count retains bounds that could otherwise add forbidden matches',()=>{
 const canonical={type:'array',contains:{type:'string',maxLength:2},maxContains:1};
 const compiled=compileWireSchema(canonical);assert.deepEqual(compiled.schema,canonical);assert.deepEqual(compiled.postValidationOnly,[]);
 const positiveOnly={type:'array',contains:{type:'string',maxLength:2},minContains:1};
 assert.equal(compileWireSchema(positiveOnly).schema.contains.maxLength,undefined);
});
