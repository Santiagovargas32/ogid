const text = maxLength => ({type:'string',minLength:1,maxLength});
const id = {type:'string',pattern:'^[A-Za-z0-9._:-]{1,100}$'};
const date = {type:'string',format:'date-time'};
const integer = {type:'integer',minimum:1,maximum:1000000};
const list = (items,maxItems) => ({type:'array',items,maxItems,uniqueItems:true});
const object = (properties,required) => ({type:'object',properties,required,additionalProperties:false});
export const SOURCE_RATINGS = Object.freeze(['left','center-left','center','center-right','right','not-applicable','unmapped']);
export const SOURCE_ASSESSMENT_METHOD = 'source-assessments-v1';
export const SOURCE_IMPORT_PROPERTIES = {
  requestId:id, dryRun:{type:'boolean'},
  permission:object({basis:{type:'string',enum:['self-authored','licensed','permission']},reference:text(500),redistributionAllowed:{type:'boolean'}},['basis','reference','redistributionAllowed']),
  assessments:list(object({assessmentId:id,revision:integer,publisherId:id,edition:text(100),evaluatorId:id,evaluatorName:text(160),politicalScope:text(80),methodId:id,methodVersion:text(80),methodUrl:text(500),originalRating:text(160),rating:{type:'string',enum:SOURCE_RATINGS},scaleVersion:{type:'string',enum:['political-five-v1','external-unmapped']},assessedAt:date,validFrom:date,validUntil:date,state:{type:'string',enum:['published','withdrawn']},evidenceUrls:list(text(500),5),licenseName:text(160),licenseUrl:text(500)},['assessmentId','revision','publisherId','edition','evaluatorId','evaluatorName','politicalScope','methodId','methodVersion','methodUrl','originalRating','rating','scaleVersion','assessedAt','validFrom','state','evidenceUrls','licenseName','licenseUrl']),25),
  profiles:list(object({publisherId:id,edition:text(100),revision:integer,verifiedAt:date,editorialCountries:list({type:'string',pattern:'^[A-Z]{2}$'},10),languages:list({type:'string',pattern:'^[a-z]{2,3}$'},10),ownerGroupId:id,ownerGroupName:text(160),evidenceUrls:list(text(500),5)},['publisherId','edition','revision','verifiedAt','editorialCountries','languages','evidenceUrls']),25)
};
export const SOURCE_IMPORT_REQUIRED = ['requestId','permission'];
export const SOURCE_IMPORT_SCHEMA = object(SOURCE_IMPORT_PROPERTIES,SOURCE_IMPORT_REQUIRED);
