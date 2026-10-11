import { Router } from "express";
import { getHealth } from "../controllers/healthController.js";

const router = Router();

router.get("/health", getHealth);
router.get("/health/live", (_req,res) => res.json({ok:true,data:{status:"alive"}}));
router.get("/health/ready", (_req,res) => {
  const ready=res.app.locals.runtimeMetrics?.ready === true;
  res.status(ready?200:503).json({ok:ready,data:{status:ready?"ready":"not-ready"}});
});

export default router;
