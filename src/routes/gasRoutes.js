import express from "express";
import gasAnalyticsService from "../services/GasAnalyticsService.js";

const router = express.Router();

/**
 * GET /api/gas/summary
 * Retrieves overall gas statistics and platform vs investor breakdown
 */
router.get("/summary", async (req, res) => {
  try {
    const summary = await gasAnalyticsService.getGasAnalyticsSummary();
    res.json({ success: true, data: summary });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/gas/benchmark
 * Retrieves research benchmarking evaluation comparing Baseline vs Merkle across 10, 100, 500, 1000 investors
 */
router.get("/benchmark", (req, res) => {
  try {
    const benchmarkResults = gasAnalyticsService.generateResearchBenchmarkResults();
    res.json({
      success: true,
      title: "Comparative Gas Optimization Benchmark for Real-World Asset Profit Distribution",
      frameworks: ["Proposed Merkle Settlement", "Baseline Push Transfer", "Baseline On-Chain Snapshot"],
      data: benchmarkResults
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/gas/record
 * Manually logs a transaction gas receipt
 */
router.post("/record", async (req, res) => {
  try {
    const metric = await gasAnalyticsService.recordTransactionGas(req.body);
    res.status(201).json({ success: true, data: metric });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
