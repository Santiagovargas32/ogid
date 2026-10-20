import { Router } from "express";
const router=Router();
const retired=(_req,res)=>res.status(410).json({ok:false,error:{code:"MEDIA_RETIRED",message:"El workspace de vídeos se ha retirado. Usar la bandeja geopolítica."}});
router.get("/streams",retired);
router.get("/streams/health",retired);
router.get("/streams/:id",retired);
router.post("/streams/refresh",retired);
export default router;
