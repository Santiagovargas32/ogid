import {currentNewsCorpus} from '../services/news/newsFreshness.js';
import {healthDiagnostics} from '../services/healthDiagnostics.js';
import stateManager from '../state/stateManager.js';
import { Router } from "express";
import { getAiEnrichments, getApiLimits, getNewsRaw, getPipelineStatus } from "../controllers/adminController.js";
import { historyStatus, createAdminHistory, runAdminHistory, importAdminHistory, replayAdminEvents } from "../controllers/historyAdminController.js";

const router = Router();

router.get("/api-limits", getApiLimits);
router.get("/news-raw", getNewsRaw);
router.get("/pipeline-status", getPipelineStatus);
router.get("/runtime", (_req,res) => res.json({ ok: true, data: {
  news:currentNewsCorpus(stateManager.getMeta().sourceMeta?.corpus)||null,
  agent:res.app.locals.agentRuntime?.status?.()||null,
  sampledAt: new Date().toISOString(),diagnostics:healthDiagnostics(res.app.locals,stateManager.getMeta()),
  storage: res.app.locals.storageManager?.getStatus?.() || null,
  runtime: res.app.locals.runtimeMetrics.snapshot(),
  websocket: res.app.locals.socketServer.getHealth(),
  refresh: { news:res.app.locals.orchestrator.newsCycleTelemetry, market:res.app.locals.orchestrator.marketCycleTelemetry,
    pending:res.app.locals.orchestrator.pendingCycles.size, coalescing:res.app.locals.orchestrator.cycleMetrics },
  rss:res.app.locals.rssAggregator.getStatus()
} }));
router.get("/ai-enrichments", getAiEnrichments);
router.get("/history", historyStatus);
router.post("/history/jobs", createAdminHistory);
router.post("/history/run", runAdminHistory);
router.post("/history/import", importAdminHistory);
router.post("/events/replay", replayAdminEvents);

export default router;
