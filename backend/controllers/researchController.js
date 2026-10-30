import {PUBLISHER_METHOD,SOURCE_PRIORITY_METHOD} from '../services/news/publisherIdentity.js';
import {NEWS_CLASSIFICATION_VERSION,NEWS_LANGUAGES} from '../services/news/newsClassification.js';
import { BACKEND_BUILD } from "../utils/buildIdentity.js";
import { OGID_OPERATIONS, OPERATIONS_VERSION, OPERATIONS_HASH, getOperation, parseOperationQuery, validateValue } from "../contracts/ogidOperations.js";
import { AppError } from "../utils/error.js";
import { listVerifiedInstruments } from "../services/market/instrumentRegistry.js";
import { instrumentView, resolveReferences } from "../services/research/instrumentIdentity.js";
import { numericProjection } from "../utils/researchProjection.js";
import stateManager from "../state/stateManager.js";
import apiQuotaTracker from "../services/admin/apiQuotaTrackerService.js";
import { researchSourceCatalog } from "../services/research/sourceCatalogView.js";
import {SourceAssessments} from '../services/news/sourceAssessments.js';
async function comparisonRead(req,res,operation,method,key){
  const input=params(req,operation);
  if(key){if(!/^[A-Za-z0-9._:-]{1,128}$/.test(req.params.id))throw new AppError('ID inválido.',400,'INVALID_COMPARISON');input[key]=req.params.id;}
  const news=res.app.locals.business?.news;
  if(!news&&key)throw new AppError('Comparación no disponible.',404,'COMPARISON_NOT_FOUND');
  res.json({ok:true,data:news?await news[method](input):{available:false,items:[],hasMore:false,nextCursor:null,coverage:{partial:true,reason:'requires-sqlite'}}});
}
export const getComparisons=(req,res)=>comparisonRead(req,res,'news.comparisons','comparisons');
export const getComparison=(req,res)=>comparisonRead(req,res,'news.comparison','comparison','groupId');
export const getComparisonClaim=(req,res)=>comparisonRead(req,res,'news.claim','comparisonClaim','claimId');
export const getComparisonChanges=(req,res)=>comparisonRead(req,res,'news.comparison.changes','comparisonChanges');
export async function reviewComparison(req,res){
  if(!req.mcpOperatorAuthorized)throw new AppError('Requiere operador news:comparisons:write.',403,'MCP_OPERATOR_FORBIDDEN');
  if(!res.app.locals.business)throw new AppError('Requiere SQLite.',503,'COMPARISON_STORAGE_REQUIRED');
  if(!validateValue(req.body,getOperation('news.comparison.review').body))throw new AppError('Revisión inválida.',400,'INVALID_COMPARISON');
  res.json({ok:true,data:await res.app.locals.business.news.reviewComparison(req.body)});
}
export async function getSourceAssessments(req,res){const input=params(req,'news.source-assessments');res.json({ok:true,data:await (res.app.locals.business?.news.sourceAssessments(input) || new SourceAssessments().catalogue(input))});}
export async function getSourceAssessment(req,res){if(!/^[A-Za-z0-9._:-]{1,100}$/.test(req.params.id))throw new AppError('ID inválido.',400,'INVALID_ASSESSMENT_ID');const input={...params(req,'news.source-assessment'),assessmentId:req.params.id};res.json({ok:true,data:await (res.app.locals.business?.news.sourceAssessment(input) || new SourceAssessments().detail(input))});}
export async function getSourceCoverage(req,res){const input=params(req,'news.source-coverage');res.json({ok:true,data:res.app.locals.business?await res.app.locals.business.news.sourceCoverage(input):{available:false,coverage:{partial:true,reason:'requires-sqlite'},summary:null}});}
async function dossierRead(req,res,op,method,{detail=false,operator=false}={}){
  if(operator&&!req.mcpOperatorAuthorized)throw new AppError('Requiere operador news:assessments:write.',403,'MCP_OPERATOR_FORBIDDEN');
  const input=params(req,op);if(detail){if(!/^[A-Za-z0-9._:-]{1,100}$/.test(req.params.id))throw new AppError('ID inválido.',400,'SOURCE_DOSSIER_INVALID');input.dossierId=req.params.id;}
  const news=res.app.locals.business?.news;if(!news){if(!operator&&!detail){res.json({ok:true,data:{available:false,items:[],hasMore:false,nextCursor:null}});return;}throw new AppError('Requiere SQLite.',operator?503:404,operator?'SOURCE_DOSSIER_STORAGE_REQUIRED':'SOURCE_DOSSIER_NOT_FOUND');}
  res.json({ok:true,data:await news[method](input)});
}
export const getSourceEvaluations=(req,res)=>dossierRead(req,res,'news.source-evaluations','sourceDossiers');
export const getSourceEvaluation=(req,res)=>dossierRead(req,res,'news.source-evaluation','sourceDossier',{detail:true});
export const getPendingSourceEvaluations=(req,res)=>dossierRead(req,res,'news.source-evaluations.pending','sourceDossierDrafts',{operator:true});
export const getPendingSourceEvaluation=(req,res)=>dossierRead(req,res,'news.source-evaluation.pending','sourceDossierDraft',{operator:true,detail:true});
async function dossierWrite(req,res,op,method){
  if(!req.mcpOperatorAuthorized)throw new AppError('Requiere operador news:assessments:write.',403,'MCP_OPERATOR_FORBIDDEN');
  if(!validateValue(req.body,getOperation(op).body))throw new AppError('Expediente inválido.',400,'SOURCE_DOSSIER_INVALID');
  if(!res.app.locals.business)throw new AppError('Requiere SQLite.',503,'SOURCE_DOSSIER_STORAGE_REQUIRED');
  res.json({ok:true,data:await res.app.locals.business.news[method](req.body)});
}
export const proposeSourceEvaluation=(req,res)=>dossierWrite(req,res,'news.source-evaluations.propose','proposeSourceDossier');
export const reviewSourceEvaluation=(req,res)=>dossierWrite(req,res,'news.source-evaluations.review','reviewSourceDossier');
export async function importSourceAssessments(req,res){
  if(!req.mcpOperatorAuthorized)throw new AppError('Requiere credencial operador news:assessments:write.',403,'MCP_OPERATOR_FORBIDDEN');
  if(!res.app.locals.business)throw new AppError('Requiere almacenamiento SQLite.',503,'SOURCE_ASSESSMENT_STORAGE_REQUIRED');
  res.json({ok:true,data:await res.app.locals.business.news.importSourceAssessments(req.body)});
}
export function params(req, id) {
  try { return parseOperationQuery(req.query, getOperation(id)); }
  catch { throw new AppError("Parámetros inválidos o ventana inconsistente.", 400, "INVALID_RESEARCH_QUERY"); }
}
export async function searchNews(req, res) { res.json({ ok: true, data: await res.app.locals.newsArchive.search(params(req, "news.search")) }); }
export async function getNewsItem(req, res) {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(req.params.id)) throw new AppError("ID inválido.", 400, "INVALID_NEWS_ID");
  res.json({ ok: true, data: await res.app.locals.newsArchive.getItem(req.params.id) });
}
export async function resolveInstruments(req, res) {
  const query = params(req, "instruments.resolve"); const universe = listVerifiedInstruments(); const snapshot = stateManager.getSnapshot();
  const resolutions = resolveReferences(query.references || [], query, universe); const ids = new Set(resolutions.flatMap(row => row.candidates));
  res.json({ ok: true, data: { generatedAt: new Date().toISOString(), registryOrigin: "verified-runtime", instruments: universe.filter(instrument => !query.references?.length || ids.has(instrument.instrumentId)).map(instrument => instrumentView(instrument, res.app.locals.marketWatchlistService.selectedInstrumentIds, snapshot.market?.quotes || {})), resolutions,
    warnings: ["La identidad de proveedor no demuestra una posición ni una clase elegida. Resolver no consulta proveedores; si falta una identidad, usar búsqueda operador y verificación explícita."] } });
}
export async function getCapabilities(_req, res) { res.json({ ok: true, data: { contractVersion: OPERATIONS_VERSION, contractHash: OPERATIONS_HASH, dashboardProfiles:['dashboard-v1'], newsEditorial:{identityMethod:PUBLISHER_METHOD,classificationMethod:NEWS_CLASSIFICATION_VERSION,languages:NEWS_LANGUAGES,sourcePriorityMethod:SOURCE_PRIORITY_METHOD,meaning:'news relevance; not verified occurrence or factual reliability'}, build: BACKEND_BUILD, generatedAt: new Date().toISOString(), operations: OGID_OPERATIONS.filter(op => op.profile === "research"), researchPipeline:res.app.locals.researchPipeline, newsCoverage: await res.app.locals.newsArchive.coverage(), runningCommitVerified: false } }); }
export async function getDiagnostics(_req, res) {
  const snapshot = stateManager.getSnapshot(); const orchestrator = res.app.locals.orchestrator;
  res.json({ ok: true, data: { generatedAt: new Date().toISOString(), counts: { news: snapshot.news.length, quotes: Object.keys(snapshot.market?.quotes || {}).length, archived: res.app.locals.newsArchive.records.size },
    quotas: apiQuotaTracker.getSnapshot().map(row => ({ provider: row.provider, metrics: numericProjection(row) })), pipeline: { news: numericProjection(orchestrator?.newsCycleTelemetry), market: numericProjection(orchestrator?.marketCycleTelemetry) },
    archive: await res.app.locals.newsArchive.coverage(), warnings: ["Diagnóstico público de métricas; cuerpos, configuración privada y logs internos no se publican."] } });
}
export async function getPortfolioContext(req, res) { res.json({ ok: true, data: await res.app.locals.portfolioContextService.getContext(params(req, "portfolio.context")) }); }
export async function acknowledgeAlerts(req, res) {
  if (!req.mcpOperatorAuthorized) throw new AppError("Requiere credencial MCP con alerts:ack.", 403, "MCP_OPERATOR_FORBIDDEN");
  if (!validateValue(req.body, getOperation("portfolio.alerts.ack").body)) throw new AppError("Entrega inválida.", 400, "INVALID_ALERT_ACK");
  res.json({ ok: true, data: await res.app.locals.materialAlertStore.acknowledge(req.body) });
}

export async function getTechnicalContext(req,res) { res.json({ok:true,data:await res.app.locals.technicalContextService.get(params(req,"market.technical-context"))}); }
export async function getEventImpact(req,res) { res.json({ok:true,data:{...await res.app.locals.eventLedger.search(params(req,"research.event-impact")),pipeline:res.app.locals.researchPipeline}}); }
export async function getResearchSources(_req,res) { res.json({ok:true,data:await researchSourceCatalog(res.app.locals)}); }
export async function getCompanyFacts(req,res) { const {companyId}=params(req,"research.companyfacts");const store=res.app.locals.researchStore;const data=store.getRow?await store.getRow("companyFacts",companyId):store.view("companyFacts")[companyId];res.json({ok:true,data:data||{companyId,metrics:null,missingReason:"no-stored-companyfacts",quality:{coverage:"not-available"}}}); }
export async function getEtfHoldings(req,res) { res.json({ok:true,data:await res.app.locals.officialSourceService.holdings(params(req,"etf.holdings"))}); }
export async function getHistoryJob(req,res) {res.json({ok:true,data:await res.app.locals.historicalAcquisitionService.get(params(req,"market.history.job").jobId)});}
export function operatorBody(req,id){if(!req.mcpOperatorAuthorized)throw new AppError("Requiere credencial MCP de alcance.",403,"MCP_OPERATOR_FORBIDDEN");if(!validateValue(req.body,getOperation(id).body))throw new AppError("Cuerpo inválido.",400,"INVALID_OPERATOR_ARGUMENTS");return req.body;}
export async function createHistoryJob(req,res){res.json({ok:true,data:await res.app.locals.historicalAcquisitionService.create(operatorBody(req,"market.history.create"))});}
export async function runHistoryJob(req,res){res.json({ok:true,data:await res.app.locals.historicalAcquisitionService.run(operatorBody(req,"market.history.run"))});}
export async function runResearchSources(req,res){res.json({ok:true,data:await res.app.locals.officialSourceService.run(operatorBody(req,"research.sources.run"))});}

export async function getScenarios(req,res){res.json({ok:true,data:await res.app.locals.scenarioService.list(params(req,"research.scenarios"))});}
export async function getSignalsDelta(req,res){res.json({ok:true,data:await res.app.locals.materialAlertStore.delta(params(req,"signals.delta"))});}
export async function refreshScenarios(req,res){res.json({ok:true,data:await res.app.locals.scenarioService.refresh(operatorBody(req,"research.scenarios.refresh"))});}
export async function deleteScenario(req,res){res.json({ok:true,data:await res.app.locals.scenarioService.remove(operatorBody(req,"research.scenarios.delete"))});}
export async function acknowledgeSignals(req,res){res.json({ok:true,data:await res.app.locals.materialAlertStore.acknowledgeChanges(operatorBody(req,"signals.checkpoint"))});}
export async function recoverSignals(req,res){res.json({ok:true,data:await res.app.locals.materialAlertStore.recoverCheckpoint(operatorBody(req,"signals.recover"))});}

export async function getForecastEvaluation(req,res){res.json({ok:true,data:await res.app.locals.forecastEvaluationService.evaluate(params(req,"research.forecast-evaluation"))});}
export async function registerForecast(req,res){res.json({ok:true,data:await res.app.locals.forecastEvaluationService.record(operatorBody(req,"research.forecast.register"))});}

export async function getSignalChange(req,res){res.json({ok:true,data:await res.app.locals.materialAlertStore.getChange(params(req,"signals.change"))});}
