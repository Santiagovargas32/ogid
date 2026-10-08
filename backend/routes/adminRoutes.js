import { Router } from "express";
import { getAiEnrichments, getApiLimits, getNewsRaw, getPipelineStatus } from "../controllers/adminController.js";
import { historyStatus, createAdminHistory, runAdminHistory, importAdminHistory, replayAdminEvents } from "../controllers/historyAdminController.js";

const router = Router();

router.get("/api-limits", getApiLimits);
router.get("/news-raw", getNewsRaw);
router.get("/pipeline-status", getPipelineStatus);
router.get("/ai-enrichments", getAiEnrichments);
router.get("/history", historyStatus);
router.post("/history/jobs", createAdminHistory);
router.post("/history/run", runAdminHistory);
router.post("/history/import", importAdminHistory);
router.post("/events/replay", replayAdminEvents);

export default router;
