import {generationSchemaForJob} from '../services/agent/briefReports.js';
import {PROMPT_VERSION} from '../services/agent/contracts.js';
import {analysisSchema} from '../services/situations/analysisSchema.js';

// Share the canonical structural schemas; identity, actual reads and factual
// checks remain the worker's responsibility. No separate permissive DTO.
const proposals=['global_intelligence_brief','market_outlook_global','instrument_outlook','geopolitical_alert_assessment','situation_analysis'].map(task=>{
  const schema=generationSchemaForJob({task,promptVersion:PROMPT_VERSION});
  return task==='situation_analysis'?{...schema,properties:{...schema.properties,situationId:analysisSchema.properties.situationId}}:schema;
});
// The pinned llama.cpp grammar expands bounded repetitions and rejects large
// string/array bounds. Guide decoding with structure; validate ALL canonical
// bounds/conditions at dispatch and again in the worker, never raise its guard.
export function proposalSamplingSchema(schema){
  if(typeof schema!=='object'||schema===null)return schema;
  const result={};
  for(const key of ['type','const','enum','required','description'])if(Object.hasOwn(schema,key))result[key]=schema[key];
  if(schema.properties)result.properties=Object.fromEntries(Object.entries(schema.properties).map(([key,value])=>[key,proposalSamplingSchema(value)]));
  for(const key of ['items','additionalProperties'])if(Object.hasOwn(schema,key))result[key]=proposalSamplingSchema(schema[key]);
  for(const key of ['anyOf','oneOf'])if(schema[key])result[key]=schema[key].map(proposalSamplingSchema);
  return result;
}
const canonicalInput={type:'object',properties:{snapshotId:{type:'string',minLength:1,maxLength:128},proposal:{anyOf:proposals}},required:['snapshotId','proposal'],additionalProperties:false};
// A local return channel, never an API operation or a publication/evidence read.
export const AGENT_PROPOSAL_TRANSPORT = Object.freeze({
  version:'ogid-agent-proposal-return-v3',
  tool:'ogid_agent_proposal',
  operationId:'agent.proposal.return',
  input:proposalSamplingSchema(canonicalInput),canonicalInput,
  samplingProjection:'types-constants-required-v1; canonical bounds and conditions remain mandatory at dispatch',
  effects:'Returns untrusted candidate data locally. No HTTP, storage, providers or publication. The worker still validates evidence and the canonical contract.'
});
export const isProposalTool=name=>typeof name==='string'&&(name===AGENT_PROPOSAL_TRANSPORT.tool||name===`ogid_read_${AGENT_PROPOSAL_TRANSPORT.tool}`);
