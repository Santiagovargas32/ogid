import { Router } from "express";
import { getHealth } from "../controllers/healthController.js";

const router = Router();

router.get("/health", getHealth);
router.get("/health/live", (_req,res) => res.json({ok:true,data:{status:"alive"}}));
router.get("/health/ready", (_req,res) => {
  const storage=res.app.locals.storageManager?.getStatus();
  const blocked=Object.values(res.app.locals.pipelineMonitor?.snapshot() || {}).some(s=>s.status === "blocked");
  const pressure=storage?.resourcePressure;
  const ready=res.app.locals.runtimeMetrics?.ready === true && (!pressure||pressure.state==='normal') && (!storage || ["ready","disabled"].includes(storage.state)) && (!storage?.analysis || storage.analysis.state === "ready") && (!storage?.queries || storage.queries.state === "ready") && !storage?.reconciliation?.pending && !storage?.analysisRecovery?.recovering && !storage?.queryRecovery?.recovering && !blocked;
  if(!ready&&pressure&&pressure.state!=='normal')res.setHeader('Retry-After','1');
  res.status(ready?200:503).json({ok:ready,data:{status:ready?"ready":"not-ready",...(pressure?{resourcePressure:{state:pressure.state,critical:pressure.critical,reason:pressure.reason}}:{})}});
});

export default router;
