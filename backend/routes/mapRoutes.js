import { Router } from "express";
import { getMapConfig, getMapLayers, getMapPresets, getMapThemes } from "../controllers/mapController.js";

const router = Router();

router.get("/config", getMapConfig);
router.get("/layers", getMapLayers);
router.get("/presets", getMapPresets);
router.get("/themes", getMapThemes);

export default router;
