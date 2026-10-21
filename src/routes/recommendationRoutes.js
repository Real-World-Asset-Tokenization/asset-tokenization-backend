import express from "express";
import { matchListings } from "../controllers/recommendationController.js";

const router = express.Router();

router.post("/match", matchListings);

export default router;
