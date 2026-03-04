import { Router } from "express";
import { getHotspots, getInsights, getNews, getRisks, getSnapshot } from "../controllers/intelController.js";

const router = Router();

router.get("/snapshot", getSnapshot);
router.get("/hotspots", getHotspots);
router.get("/risks", getRisks);
router.get("/news", getNews);
router.get("/insights", getInsights);

export default router;
