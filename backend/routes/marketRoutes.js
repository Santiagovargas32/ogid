import { Router } from "express";
import { getAnalytics, getImpact, getQuotes } from "../controllers/marketController.js";

const router = Router();

router.get("/quotes", getQuotes);
router.get("/impact", getImpact);
router.get("/analytics", getAnalytics);

export default router;
