import { Router } from "express";
import { getHotspots, getInsights, getNews, getRisks, getSnapshot, postRefresh } from "../controllers/intelController.js";
import { getCountryInstability, getHotspotsV2, getIntelAnomalies } from "../controllers/intelAdvancedController.js";

const router = Router();

router.get("/snapshot", getSnapshot);
router.post("/refresh", postRefresh);
router.get("/hotspots", getHotspots);
router.get("/risks", getRisks);
router.get("/news", getNews);
router.get("/insights", getInsights);
router.get("/hotspots-v2", getHotspotsV2);
router.get("/anomalies", getIntelAnomalies);

router.get("/country-instability", getCountryInstability);

export default router;
