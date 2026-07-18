import { Router } from "express";
import { backfillCandles, getAnalytics, getCandleMetrics, getCandles, getImpact, getProviderStatus, getQuotes, getTechnicalIndicators, getWatchlist, searchInstruments, updateWatchlist } from "../controllers/marketController.js";

const router = Router();

router.get("/quotes", getQuotes);
router.get("/provider-status", getProviderStatus);
router.get("/instruments/search", searchInstruments);
router.get("/watchlist", getWatchlist);
router.put("/watchlist", updateWatchlist);
router.get("/candles", getCandles);
router.get("/candles/metrics", getCandleMetrics);
router.get("/indicators", getTechnicalIndicators);
router.post("/candles/backfill", backfillCandles);
router.get("/impact", getImpact);
router.get("/analytics", getAnalytics);

export default router;
