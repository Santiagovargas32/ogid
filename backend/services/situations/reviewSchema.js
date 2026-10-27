const text=maxLength=>({type:'string',minLength:1,maxLength});
const identifier={...text(128),pattern:'^[A-Za-z0-9._:-]+$'};
export const SITUATION_REVIEW_PROPERTIES={
 requestId:identifier,action:{type:'string',enum:['create-incident','link-incident','verification']},entityId:identifier,
 title:text(512),reviewer:text(120),reason:text(2000),references:{type:'array',minItems:1,maxItems:20,items:text(2048)},
 sourceRefs:{type:'array',maxItems:25,items:{type:'object',properties:{stream:{type:'string',enum:['news','awareness']},sourceId:identifier,sourceRevision:{type:'integer',minimum:1,maximum:2147483647}},required:['stream','sourceId','sourceRevision'],additionalProperties:false}},
 verification:{type:'string',enum:['unverified','reviewed-supported','reviewed-disputed','retracted']},
 occurredAt:{...text(80),format:'date-time'},occurrenceBasis:text(500)
};
export const SITUATION_REVIEW_REQUIRED=['requestId','action','entityId','reviewer','reason','references'];
