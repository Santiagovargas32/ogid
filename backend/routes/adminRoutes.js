import { Router } from "express";
import { getAiEnrichments, getApiLimits, getNewsRaw, getPipelineStatus } from "../controllers/adminController.js";

const router = Router();

router.get("/api-limits", getApiLimits);
router.get("/news-raw", getNewsRaw);
router.get("/pipeline-status", getPipelineStatus);
router.get("/ai-enrichments", getAiEnrichments);

export default router;
