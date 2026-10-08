import { Router } from "express";
import { backfillCandles, getAnalytics, getCandleMetrics, getCandles, getConditions, getImpact, getProviderStatus, getQuotes, getTechnicalIndicators, getWatchlist, searchInstruments, updateWatchlist } from "../controllers/marketController.js";
import { getTechnicalContext, getHistoryJob, createHistoryJob, runHistoryJob, resolveInstruments } from "../controllers/researchController.js";
import { historyDatasets } from "../controllers/historyAdminController.js";

const router = Router();

router.get("/technical-context",getTechnicalContext);
router.get("/history/jobs",getHistoryJob);
router.get("/history/datasets",historyDatasets);
router.post("/history/jobs",createHistoryJob);
router.post("/history/run",runHistoryJob);
router.get("/quotes", getQuotes);
router.get("/provider-status", getProviderStatus);
router.get("/instruments/search", searchInstruments);
router.get("/instruments/resolve", resolveInstruments);
router.get("/watchlist", getWatchlist);
router.put("/watchlist", updateWatchlist);
router.get("/candles", getCandles);
router.get("/candles/metrics", getCandleMetrics);
router.get("/indicators", getTechnicalIndicators);
router.post("/candles/backfill", backfillCandles);
router.get("/impact", getImpact);
router.get("/analytics", getAnalytics);
router.get("/conditions", getConditions);

export default router;
