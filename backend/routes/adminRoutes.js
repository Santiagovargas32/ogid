import { Router } from "express";
import { getApiLimits, getPipelineStatus } from "../controllers/adminController.js";

const router = Router();

router.get("/api-limits", getApiLimits);
router.get("/pipeline-status", getPipelineStatus);

export default router;
