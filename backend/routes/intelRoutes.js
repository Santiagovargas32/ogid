import { Router } from "express";
import { getDashboardBootstrap, getSyncSnapshot, getSyncChanges, getAwarenessSnapshot, getHotspots, getInsights, getNews, getRisks, getSnapshot, postRefresh } from "../controllers/intelController.js";
import {
  getAdvancedIntelligenceSnapshot,getAdvancedJobStatus,
  getCountryInstability,
  getHotspotsV2,
  getIntelAnomalies
} from "../controllers/intelAdvancedController.js";

const router = Router();

router.get("/snapshot", getSnapshot);
router.get('/bootstrap',getDashboardBootstrap);
router.get("/sync", getSyncSnapshot);
router.get("/changes", getSyncChanges);
router.post("/refresh", postRefresh);
router.get("/hotspots", getHotspots);
router.get("/risks", getRisks);
router.get("/news", getNews);
router.get("/insights", getInsights);
router.get("/awareness-snapshot", getAwarenessSnapshot);
router.get("/advanced-snapshot/status",getAdvancedJobStatus);
router.get("/advanced-snapshot", getAdvancedIntelligenceSnapshot);
router.get("/hotspots-v2", getHotspotsV2);
router.get("/anomalies", getIntelAnomalies);

router.get("/country-instability", getCountryInstability);

export default router;
