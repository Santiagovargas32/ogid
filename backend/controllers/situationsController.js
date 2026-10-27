import {getOperation,parseOperationQuery,validateValue} from '../contracts/ogidOperations.js';
import {AppError} from '../utils/error.js';
const read=method=>async(req,res)=>{
 const operation=getOperation(`situations.${method==='list'?'list':method}`);let input;
 try{input=parseOperationQuery(req.query,operation);}catch{throw new AppError('Parámetros de situaciones inválidos.',400,'SITUATION_INVALID_FILTER');}
 if(req.params.id){if(!/^[A-Za-z0-9._:-]{1,128}$/.test(req.params.id))throw new AppError('Identificador inválido.',400,'SITUATION_INVALID_ID');input.id=req.params.id;}
 const service=req.app.locals.business?.situations;
 if(!service){
  if(input.id)throw new AppError('Situación desconocida.',404,'SITUATION_NOT_FOUND');
  return res.json({ok:true,data:{available:false,items:[],hasMore:false,nextCursor:null,state:'unavailable',coverage:{partial:true,reason:'requires-sqlite'}}});
 }
 res.json({ok:true,data:await service[method](input)});
};
export const getSituations=read('list'),getSituation=read('detail'),getSituationRevisions=read('revisions'),getSituationChanges=read('changes'),getSituationStatus=read('status');
export async function reviewSituation(req,res){
 if(!req.mcpOperatorAuthorized)throw new AppError('Requiere permiso situations:write.',403,'MCP_OPERATOR_FORBIDDEN');
 if(!validateValue(req.body,getOperation('situations.review').body))throw new AppError('Revisión inválida.',400,'SITUATION_INVALID_REVIEW');
 if(!req.app.locals.business?.situations)throw new AppError('Requiere SQLite.',503,'SITUATION_STORAGE_REQUIRED');
 res.json({ok:true,data:await req.app.locals.business.situations.review(req.body)});
}
