import { BACKEND_BUILD } from "../utils/buildIdentity.js";
import { OGID_OPERATIONS, OPERATIONS_VERSION, getOperation, parseOperationQuery, validateValue } from "../contracts/ogidOperations.js";
import { AppError } from "../utils/error.js";
import { listVerifiedInstruments } from "../services/market/instrumentRegistry.js";
import { instrumentView, resolveReferences } from "../services/research/instrumentIdentity.js";
import { numericProjection } from "../utils/researchProjection.js";
import stateManager from "../state/stateManager.js";
import apiQuotaTracker from "../services/admin/apiQuotaTrackerService.js";
import { researchSourceCatalog } from "../services/research/sourceCatalogView.js";
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
export async function getCapabilities(_req, res) { res.json({ ok: true, data: { contractVersion: OPERATIONS_VERSION, build: BACKEND_BUILD, generatedAt: new Date().toISOString(), operations: OGID_OPERATIONS.filter(op => op.profile === "research"), researchPipeline:res.app.locals.researchPipeline, newsCoverage: await res.app.locals.newsArchive.coverage(), runningCommitVerified: false } }); }
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
