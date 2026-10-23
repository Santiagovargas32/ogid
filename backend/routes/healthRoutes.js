import { Router } from "express";
import { getHealth } from "../controllers/healthController.js";

const router = Router();

router.get("/health", getHealth);
router.get("/health/live", (_req,res) => res.json({ok:true,data:{status:"alive"}}));
router.get("/health/ready", (_req,res) => {
  const storage=res.app.locals.storageManager?.getStatus();
  const blocked=Object.values(res.app.locals.pipelineMonitor?.snapshot() || {}).some(s=>s.status === "blocked");
  const ready=res.app.locals.runtimeMetrics?.ready === true && (!storage || ["ready","disabled"].includes(storage.state)) && (!storage?.analysis || storage.analysis.state === "ready") && (!storage?.queries || storage.queries.state === "ready") && !storage?.reconciliation?.pending && !storage?.analysisRecovery?.recovering && !storage?.queryRecovery?.recovering && !blocked;
  res.status(ready?200:503).json({ok:ready,data:{status:ready?"ready":"not-ready"}});
});

export default router;
