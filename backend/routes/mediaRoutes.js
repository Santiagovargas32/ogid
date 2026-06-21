import { Router } from "express";
import {
  getMediaStreamById,
  getMediaStreams,
  getMediaStreamsHealth,
  refreshMediaStreams
} from "../controllers/mediaController.js";

const router = Router();

router.get("/streams", getMediaStreams);
router.get("/streams/health", getMediaStreamsHealth);
router.get("/streams/:id", getMediaStreamById);
router.post("/streams/refresh", refreshMediaStreams);

export default router;
