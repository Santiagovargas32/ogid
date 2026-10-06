import { Router } from "express";
import { acknowledgeAlerts, getCapabilities, getDiagnostics, getPortfolioContext } from "../controllers/researchController.js";
const router = Router();
router.get("/capabilities", getCapabilities);
router.get("/diagnostics", getDiagnostics);
router.get("/portfolio/context", getPortfolioContext);
router.post("/portfolio/alerts/ack", acknowledgeAlerts);
export default router;
