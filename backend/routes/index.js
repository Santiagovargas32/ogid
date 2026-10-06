import { Router } from "express";
import { getCountryInstability } from "../controllers/intelAdvancedController.js";
import adminRoutes from "./adminRoutes.js";
import healthRoutes from "./healthRoutes.js";
import intelRoutes from "./intelRoutes.js";
import mediaRoutes from "./mediaRoutes.js";
import mapRoutes from "./mapRoutes.js";
import marketRoutes from "./marketRoutes.js";
import newsRoutes from "./newsRoutes.js";
import researchRoutes from "./researchRoutes.js";

const router = Router();

router.use(healthRoutes);
router.use(researchRoutes);
router.get("/country-instability", getCountryInstability);
router.use("/admin", adminRoutes);
router.use("/intel", intelRoutes);
router.use("/media", mediaRoutes);
router.use("/market", marketRoutes);
router.use("/map", mapRoutes);
router.use("/news", newsRoutes);

export default router;
