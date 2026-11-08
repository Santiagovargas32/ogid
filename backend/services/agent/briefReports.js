import Ajv from 'ajv';
import {publicationSchemaForJob,validatePublicationForJob,publicationExample,agentError,PROMPT_VERSION} from './contracts.js';
import {usesStructuredBrief} from './narrativeFacts.js';

// The model selects source fields. It never supplies the rendered factual
// summary; the existing publication validator still checks every exact quote.
const report={type:'object',additionalProperties:false,required:['evidenceId','path','quote'],properties:{
 evidenceId:{type:'string',minLength:1,maxLength:256},
 path:{enum:['title','excerpt']},quote:{type:'string',minLength:1,maxLength:2000}
}};
export function generationSchemaForJob(job){
 const schema=publicationSchemaForJob(job);if(!usesStructuredBrief(job))return schema;
 const {summary,...properties}=schema.properties;
 const deriveReferences=job.promptVersion==='ogid-analyst-v1.22';
 return {...schema,required:[...schema.required.filter(k=>k!=='summary'),'sourceReports'],
  properties:{...properties,...(deriveReferences?{evidenceIds:{...properties.evidenceIds,minItems:0}}:{}),sourceReports:{type:'array',maxItems:4,uniqueItems:true,items:report}},
  allOf:[...schema.allOf.filter(rule=>!rule.if?.properties?.summary),{
   if:{properties:{sourceReports:{minItems:1}}},then:{required:['drivers'],properties:{drivers:{minItems:1}}},
   else:{properties:{drivers:{maxItems:0},...(deriveReferences?{evidenceIds:{minItems:1}}:{})}}
  }]
 };
}
// The model wire contract can derive references; the final publication still
// requires its complete nonempty reference set. Keep historical wire schemas.
const selectionValidators=new Map(),selectionAjv=new Ajv({allErrors:true,strict:false});
export function validateGeneratedPublication(value,job){
 let validator=validatePublicationForJob;
 if(usesStructuredBrief(job)){
  if(!selectionValidators.has(job.promptVersion))selectionValidators.set(job.promptVersion,selectionAjv.compile(generationSchemaForJob(job)));
  validator=selectionValidators.get(job.promptVersion);
 }
 const valid=validator(value,job);validateGeneratedPublication.errors=validator.errors||[];return valid;
}
export function materializeGeneratedPublication(value,job){
 if(!usesStructuredBrief(job))return value;
 if(!validateGeneratedPublication(value,job))throw agentError('AGENT_INVALID_PUBLICATION');
 const {sourceReports,...proposal}=value;
 const sourceFacts=sourceReports.map(r=>({kind:'reported-claim',field:'/summary',literal:[...r.quote].slice(0,256).join(''),...r}));
 return {...proposal,summary:sourceReports.length?'Resumen de relatos atribuidos:\n'+sourceReports.map(r=>`Según la fuente [evidence:${r.evidenceId}]: «${r.quote}»`).join('\n'):'La evidencia consultada no permite una síntesis comprobable.',
  evidenceIds:[...new Set([...proposal.evidenceIds,...sourceReports.map(r=>r.evidenceId)])],
  narrativeFacts:[...proposal.narrativeFacts,...sourceFacts]
 };
}
export function generationExample(job,evidenceId){
 const value=publicationExample(job,evidenceId);if(!value||!usesStructuredBrief(job))return value;
 const {summary,...rest}=value;return {...rest,sourceReports:[],drivers:[]};
}
