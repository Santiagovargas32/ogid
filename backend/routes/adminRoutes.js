import { Router } from "express";
import { getApiLimits } from "../controllers/adminController.js";

const router = Router();

router.get("/api-limits", getApiLimits);

export default router;
