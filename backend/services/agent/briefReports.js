import Ajv from 'ajv';
import {publicationSchemaForJob,validatePublicationForJob,publicationExample,agentError,PROMPT_VERSION} from './contracts.js';
import {usesStructuredBrief} from './narrativeFacts.js';
import {briefVerificationFocuses,briefVerificationFocusDescription,briefFocusCompatibility,renderBriefVerificationPlan} from './briefVerificationPlans.js';

export const usesBoundBriefPlans=job=>usesStructuredBrief(job)&&['ogid-analyst-v1.25','ogid-analyst-v1.26'].includes(job.promptVersion);

// The model selects source fields. It never supplies the rendered factual
// summary; the existing publication validator still checks every exact quote.
const report={type:'object',additionalProperties:false,required:['evidenceId','path','quote'],properties:{
 evidenceId:{type:'string',minLength:1,maxLength:256},
 path:{enum:['title','excerpt']},quote:{type:'string',minLength:1,maxLength:2000}
}};
export function generationSchemaForJob(job){
 const schema=publicationSchemaForJob(job);if(!usesStructuredBrief(job))return schema;
 if(usesBoundBriefPlans(job)){
  const keys=['schemaVersion','task','direction','sentiment','stability','horizonHours','probability','confidenceKind','evidenceIds','technicalFacts','narrativeFacts'];
  const properties=Object.fromEntries(keys.map(key=>[key,schema.properties[key]]));
  for(const key of ['direction','sentiment','stability'])properties[key]={const:'unavailable'};
  for(const key of ['technicalFacts','narrativeFacts'])properties[key]={...properties[key],maxItems:0};
  properties.evidenceIds={...properties.evidenceIds,minItems:0,maxItems:4};
  properties.sourceReports={type:'array',maxItems:4,uniqueItems:true,description:'Relatos distintos leídos realmente; evita titulares con el mismo arranque literal. Cada relato tiene su propio enfoque, sin cruzar actores.',items:{...report,
   required:[...report.required,'verificationFocus'],properties:{...report.properties,verificationFocus:{enum:briefVerificationFocuses(job),description:briefVerificationFocusDescription(job)}},
   ...(job.promptVersion==='ogid-analyst-v1.26'?{allOf:briefFocusCompatibility}:{})
  }};
  return {...schema,properties,required:[...keys,'sourceReports'],allOf:[{if:{properties:{sourceReports:{maxItems:0}}},then:{properties:{evidenceIds:{minItems:1}}}}]};
 }
 const {summary,...properties}=schema.properties;
 const deriveReferences=['ogid-analyst-v1.22','ogid-analyst-v1.23','ogid-analyst-v1.24'].includes(job.promptVersion);
 const guidedBrief=['ogid-analyst-v1.23','ogid-analyst-v1.24'].includes(job.promptVersion);
 const driver=properties.drivers.items;
 const guidance={
  domain:'Dominio del relato citado; noticias de conflictos y diplomacia pertenecen a geopolitical, no technical.',
  description:'Pregunta concreta sobre información DESCONOCIDA que cambiaría la interpretación del relato. No repitas ni pidas sólo confirmar el titular. Redacta en español.',
  mechanism:'Explica condicionalmente por qué la respuesta a esa pregunta cambiaría la interpretación. No afirmes efectos ni causas que el titular no acredita.',
  confirmation:'Documento o dato preciso y su contenido observable que respondería a la pregunta; un evidenceId por sí solo no es un criterio.',
  invalidation:'Información positiva que contradiga la interpretación inicial, como texto o alcance incompatibles. La ausencia de noticias o un desmentido sin respaldo mantienen incertidumbre, no prueban falsedad.'
 };
 const guidedProperties=guidedBrief?{
  drivers:{...properties.drivers,items:{...driver,properties:{...driver.properties,...Object.fromEntries(Object.entries(guidance).map(([key,description])=>[key,{...driver.properties[key],description}]))}}},
  limitations:{...properties.limitations,description:'Carencias concretas de los relatos seleccionados, como sólo disponer del titular o no conocer la cadena de origen. Obligatorio si hay relatos. En español y sin conteos ni etiquetas internas.'}
 }:{};
 return {...schema,required:[...schema.required.filter(k=>k!=='summary'),'sourceReports'],
  properties:{...properties,...guidedProperties,...(deriveReferences?{evidenceIds:{...properties.evidenceIds,minItems:0}}:{}),sourceReports:{type:'array',maxItems:4,uniqueItems:true,items:report}},
  allOf:[...schema.allOf.filter(rule=>!rule.if?.properties?.summary),{
   if:{properties:{sourceReports:{minItems:1}}},then:{required:['drivers'],properties:{drivers:{minItems:1},...(guidedBrief?{limitations:{minItems:1}}:{})}},
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
 const valid=validator(value,job),issues=[...(validator.errors||[])];
 if(usesBoundBriefPlans(job)&&Array.isArray(value?.sourceReports)){
  const leads=new Map();
  for(const [index,row]of value.sourceReports.slice(0,5).entries()){
   if(typeof row?.quote!=='string')continue;
   const words=row.quote.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)||[];
   if(words.length<7)continue;const lead=words.slice(0,7).join(' ');
   if(leads.has(lead))issues.push({instancePath:`/sourceReports/${index}/quote`,keyword:'repeatedLead',params:{otherIndex:leads.get(lead)}});
   else leads.set(lead,index);
  }
 }
 validateGeneratedPublication.errors=issues;return valid&&!issues.length;
}
export function materializeGeneratedPublication(value,job){
 if(!usesStructuredBrief(job))return value;
 if(!validateGeneratedPublication(value,job))throw agentError('AGENT_INVALID_PUBLICATION');
 const {sourceReports,...proposal}=value;
 const sourceFacts=sourceReports.map(({evidenceId,path,quote})=>({kind:'reported-claim',field:'/summary',literal:[...quote].slice(0,256).join(''),evidenceId,path,quote}));
 return {...proposal,summary:sourceReports.length?'Resumen de relatos atribuidos:\n'+sourceReports.map(r=>`Según la fuente [evidence:${r.evidenceId}]: «${r.quote}»`).join('\n'):'La evidencia consultada no permite una síntesis comprobable.',
  evidenceIds:[...new Set([...proposal.evidenceIds,...sourceReports.map(r=>r.evidenceId)])],
  narrativeFacts:[...proposal.narrativeFacts,...sourceFacts],
  ...(usesBoundBriefPlans(job)?{drivers:sourceReports.map(renderBriefVerificationPlan),contradictions:[],invalidation:[],limitations:sourceReports.length?[
   sourceReports.every(r=>r.path==='title')?'Las citas seleccionadas son titulares: no incluyen el desarrollo de los textos ni prueban por sí solas los relatos.':'Las citas reproducen los campos seleccionados de las fuentes; no constituyen una comprobación independiente de sus relatos.',
   'La selección no mide importancia global ni acredita independencia entre medios. Los planes son métodos de comprobación, no hechos ni efectos confirmados.'
  ]:['No se han seleccionado relatos que permitan una síntesis comprobable en este corte.','La ausencia de relatos seleccionados no demuestra que no existan noticias fuera de la muestra.']}: {})
 };
}
export function generationExample(job,evidenceId){
 const value=publicationExample(job,evidenceId);if(!value||!usesStructuredBrief(job))return value;
 const {summary,...rest}=value;
 if(usesBoundBriefPlans(job)){const {limitations,contradictions,invalidation,...selection}=rest;return {...selection,sourceReports:[]};}
 return {...rest,sourceReports:[],drivers:[]};
}
