import { Router } from "express";
import { getApiLimits, getNewsRaw, getPipelineStatus } from "../controllers/adminController.js";

const router = Router();

router.get("/api-limits", getApiLimits);
router.get("/news-raw", getNewsRaw);
router.get("/pipeline-status", getPipelineStatus);

export default router;
