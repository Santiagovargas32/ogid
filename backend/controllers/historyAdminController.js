import { getOperation, validateValue } from "../contracts/ogidOperations.js";
import { listVerifiedInstruments } from "../services/market/instrumentRegistry.js";
import { AppError } from "../utils/error.js";
import { researchSourceCatalog } from "../services/research/sourceCatalogView.js";

function body(req,id) {
  // Autorización admin aplicada globalmente; MCP además comprueba perfil/alcance.
  if(!validateValue(req.body,getOperation(id).body))throw new AppError("Datos de histórico inválidos.",400,"INVALID_HISTORY_ARGUMENTS");
  return req.body;
}
export function historyStatus(_req,res) {
  const {historicalAcquisitionService:history,historicalImportService:imports,researchStore}=res.app.locals;
  res.json({ok:true,data:{instruments:listVerifiedInstruments().map(i=>({instrumentId:i.instrumentId,symbol:i.canonicalSymbol,currency:i.currency,missingIdentity:["companyId","calendarId","mic","isin"].filter(k=>!i[k]),coverage:history.coverage(i.instrumentId)})),
    jobs:Object.values(researchStore.state.jobs).filter(j=>j.kind!=="csv-import").sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,50).map(j=>history.get(j.jobId)),datasets:imports.datasets(),researchSources:researchSourceCatalog(res.app.locals),
    eventIdentity:{verified:Object.values(researchStore.state.events).filter(e=>e.identityVersion==="source-publication-v2").length,legacyRequiresReplay:Object.values(researchStore.state.events).filter(e=>e.identityVersion!=="source-publication-v2").map(e=>({eventId:e.eventId,evidenceCount:e.evidence.length,reason:"legacy_identity_requires_replay; excluded from impacts"})).slice(0,100)}}});
}
export function historyDatasets(_req,res){res.json({ok:true,data:{datasets:res.app.locals.historicalImportService.datasets()}});}
export function createAdminHistory(req,res){res.json({ok:true,data:res.app.locals.historicalAcquisitionService.create(body(req,"admin.history.create"))});}
export async function runAdminHistory(req,res){res.json({ok:true,data:await res.app.locals.historicalAcquisitionService.run(body(req,"admin.history.run"))});}
export async function importAdminHistory(req,res){res.json({ok:true,data:await res.app.locals.historicalImportService.import(body(req,"admin.history.import"))});}
export function replayAdminEvents(req,res){const input=body(req,"admin.events.replay");res.json({ok:true,data:res.app.locals.eventLedger.replayAwareness(res.app.locals.awarenessService.getSnapshot({limit:250},{publicView:true}),input)});}
