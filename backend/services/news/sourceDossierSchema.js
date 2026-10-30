import {SOURCE_IMPORT_PROPERTIES} from './sourceAssessmentSchema.js';
const text=maxLength=>({type:'string',minLength:1,maxLength});
const id={type:'string',pattern:'^[A-Za-z0-9._:-]{1,100}$'};
const date={type:'string',format:'date-time'};
const list=(items,maxItems)=>({type:'array',items,maxItems});
const object=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
export const DOSSIER_METHOD='ogid-source-review-v1';
export const SOURCE_CRITERIA=['attribution','verifiability','time-and-place','content-labels','corrections'];
const reference=object({id,url:text(500),retrievedAt:date,basis:{type:'string',enum:['publisher-declared','observed','external-document']},note:text(600)});
const sample=object({id,articleId:id,articleRevision:{type:'integer',minimum:1},url:text(500),title:text(600),publishedAt:date,receivedAt:date,originChainId:{type:['string','null'],maxLength:160},textScope:{type:'string',enum:['headline','excerpt','permitted-text']},type:{type:'string',enum:['news','analysis','opinion','institutional','unknown']}},['id','url','title','publishedAt','receivedAt','originChainId','textScope','type']);
const observation=object({sampleId:id,outcome:{type:'string',enum:['supported','problem','unobservable']},note:text(500),evidenceIds:list(id,10)});
const criterion=object({status:{type:'string',enum:['backed','mixed','problems','insufficient-evidence']},summary:text(1000),evidenceIds:list(id,10),observations:list(observation,30)});
export const SOURCE_DOSSIER=object({
 dossierId:id,revision:{type:'integer',minimum:1},methodVersion:{type:'string',enum:[DOSSIER_METHOD]},author:text(120),asOf:date,validFrom:date,
 permission:SOURCE_IMPORT_PROPERTIES.permission,profile:SOURCE_IMPORT_PROPERTIES.profiles.items,
 profileStatements:list(object({field:text(80),value:text(600),basis:{type:'string',enum:['publisher-declared','observed','external-document']},evidenceIds:list(id,10)}),15),
 evidence:list(reference,40),sample:list(sample,30),selection:text(2000),limitations:list(text(600),15),
 political:object({scope:text(80),status:{type:'string',enum:['supported','mixed','insufficient-evidence','not-applicable']},rating:{type:['string','null'],enum:['left','center-left','center','center-right','right',null]},summary:text(2000),sampleIds:list(id,30),evidenceIds:list(id,15),counterEvidenceIds:list(id,15)}),
 journalism:object(Object.fromEntries(SOURCE_CRITERIA.map(key=>[key,criterion])))
});
export const DOSSIER_PROPOSE={requestId:id,dossier:SOURCE_DOSSIER};
export const DOSSIER_REVIEW={requestId:id,dossierId:id,revision:{type:'integer',minimum:1},contentHash:{type:'string',pattern:'^[a-f0-9]{64}$'},decision:{type:'string',enum:['approve','reject','changes-requested','withdraw']},reviewer:text(120),reason:text(2000)};

export const SOURCE_DOSSIER_ERRORS=['SOURCE_DOSSIER_ALREADY_REVIEWED', 'SOURCE_DOSSIER_ARTICLE_MISMATCH', 'SOURCE_DOSSIER_ARTICLE_REVISION_MISSING', 'SOURCE_DOSSIER_CRITERION_INCONSISTENT', 'SOURCE_DOSSIER_CURSOR_INVALID', 'SOURCE_DOSSIER_DUPLICATED_ORIGIN', 'SOURCE_DOSSIER_DUPLICATE_OBSERVATION', 'SOURCE_DOSSIER_DUPLICATE_REFERENCE', 'SOURCE_DOSSIER_FUTURE_CUT', 'SOURCE_DOSSIER_INVALID', 'SOURCE_DOSSIER_INVALID_REFERENCE', 'SOURCE_DOSSIER_NOT_FOUND', 'SOURCE_DOSSIER_OUTPUT_TOO_LARGE', 'SOURCE_DOSSIER_PERMISSION_REQUIRED', 'SOURCE_DOSSIER_POLITICAL_EVIDENCE_REQUIRED', 'SOURCE_DOSSIER_PROFILE_NOT_PUBLISHED', 'SOURCE_DOSSIER_PROFILE_REFERENCE', 'SOURCE_DOSSIER_REFERENCE_REQUIRED', 'SOURCE_DOSSIER_REQUEST_CONFLICT', 'SOURCE_DOSSIER_REVIEW_CONFLICT', 'SOURCE_DOSSIER_REVIEW_INVALID', 'SOURCE_DOSSIER_REVIEW_STALE', 'SOURCE_DOSSIER_REVISION_CONFLICT', 'SOURCE_DOSSIER_SAMPLE_EDITION_MISMATCH', 'SOURCE_DOSSIER_SAMPLE_INVALID', 'SOURCE_DOSSIER_STORAGE_REQUIRED', 'SOURCE_DOSSIER_SUBJECT_CONFLICT', 'SOURCE_DOSSIER_TOO_LARGE'];
