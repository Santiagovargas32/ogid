import { Router } from "express";
import { getMediaStreams } from "../controllers/mediaController.js";

const router = Router();

router.get("/streams", getMediaStreams);

export default router;

