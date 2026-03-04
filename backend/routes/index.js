import { Router } from "express";
import adminRoutes from "./adminRoutes.js";
import healthRoutes from "./healthRoutes.js";
import intelRoutes from "./intelRoutes.js";
import marketRoutes from "./marketRoutes.js";

const router = Router();

router.use(healthRoutes);
router.use("/admin", adminRoutes);
router.use("/intel", intelRoutes);
router.use("/market", marketRoutes);

export default router;
