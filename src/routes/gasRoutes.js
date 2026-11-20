import express from "express";
import gasAnalyticsService from "../services/GasAnalyticsService.js";
import { protect, authorize } from "../middleware/auth.js";

const router = express.Router();

// Gas analytics is an operator tool: only administrators may read or write it.
router.use(protect, authorize("admin"));

/**
 * GET /api/gas/summary
 * Retrieves overall gas statistics and platform vs investor breakdown
 */
// Read any transactions mined since the last look so the numbers always match the chain. If the chain is
// unreachable the records already stored are still shown.
const syncQuietly = () => gasAnalyticsService.syncChain().catch((err) => console.warn("[GasAnalytics] sync skipped:", err.message));

router.get("/summary", async (req, res) => {
  try {
    await syncQuietly();
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
    const benchmark = gasAnalyticsService.getResearchBenchmark();
    res.json({
      success: true,
      title: "Comparative Gas Optimization Benchmark for Real-World Asset Profit Distribution",
      frameworks: ["Proposed Merkle Settlement", "Baseline Push Transfer", "Baseline On-Chain Snapshot"],
      ...benchmark
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/gas/transactions?limit=&stage=&category=
 * The recorded transactions with their evidence (hash, method, block, gas used, price paid)
 */
router.get("/transactions", async (req, res) => {
  try {
    await syncQuietly();
    const { limit, stage, category } = req.query;
    const data = await gasAnalyticsService.listTransactions({ limit, stage, category });
    res.json({ success: true, count: data.length, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/gas/sync
 * Reads new blocks now and records the business transactions in them
 */
router.post("/sync", async (req, res) => {
  try {
    res.json({ success: true, data: await gasAnalyticsService.syncChain() });
  } catch (err) {
    res.status(503).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/gas/scenario
 * End-to-end property scenario, baseline vs optimized, with transaction evidence
 */
router.get("/scenario", (req, res) => {
  try {
    res.json({ success: true, ...gasAnalyticsService.getScenarioBenchmark() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/gas/optimizations
 * Measured gas saved by signed marketplace orders and batched signed votes
 */
router.get("/optimizations", (req, res) => {
  try {
    res.json({ success: true, ...gasAnalyticsService.getOptimizationBenchmark() });
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
