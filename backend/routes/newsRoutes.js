import { Router } from "express";
import { getAggregateNews } from "../controllers/newsController.js";

const router = Router();

router.get("/aggregate", getAggregateNews);

export default router;
