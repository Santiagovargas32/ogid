import { Router } from "express";
import { getAggregateNews } from "../controllers/newsController.js";
import { getNewsItem, searchNews } from "../controllers/researchController.js";

const router = Router();

router.get("/aggregate", getAggregateNews);
router.get("/search", searchNews);
router.get("/items/:id", getNewsItem);

export default router;
