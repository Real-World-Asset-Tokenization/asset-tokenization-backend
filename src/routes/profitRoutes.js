import express from "express";
import { ethers } from "ethers";
import FinancialReport from "../models/FinancialReport.js";
import profitCalculationService from "../services/ProfitCalculationService.js";
import ownershipIndexer from "../services/OwnershipIndexer.js";

const router = express.Router();

/**
 * GET /api/profit/reports
 * Lists financial reports, optionally filtered by assetId
 */
router.get("/reports", async (req, res) => {
  try {
    const filter = {};
    if (req.query.assetId) {
      filter.assetId = Number(req.query.assetId);
    }
    const reports = await FinancialReport.find(filter);
    res.json({ success: true, count: reports.length, data: reports });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/profit/reports
 * Submits a new financial period report
 */
router.post("/reports", async (req, res) => {
  try {
    const {
      assetId,
      periodLabel,
      startDate,
      endDate,
      grossRentalIncome,
      operatingExpenses,
      maintenanceReserve = 0,
      carriedForwardLoss = 0,
      notes = ""
    } = req.body;

    if (!assetId || !periodLabel || !startDate || !endDate) {
      return res.status(400).json({ success: false, message: "Missing required report parameters" });
    }

    const startTs = Math.floor(new Date(startDate).getTime() / 1000);
    const endTs = Math.floor(new Date(endDate).getTime() / 1000);

    const gross = Number(grossRentalIncome) || 0;
    const exp = Number(operatingExpenses) || 0;
    const resv = Number(maintenanceReserve) || 0;
    const priorLoss = Number(carriedForwardLoss) || 0;

    const netOperatingProfit = gross - exp - resv;
    let distributableAmount = 0;
    let newLossCarryForward = 0;

    if (netOperatingProfit > 0) {
      if (netOperatingProfit > priorLoss) {
        distributableAmount = netOperatingProfit - priorLoss;
        newLossCarryForward = 0;
      } else {
        distributableAmount = 0;
        newLossCarryForward = priorLoss - netOperatingProfit;
      }
    } else {
      distributableAmount = 0;
      newLossCarryForward = priorLoss + Math.abs(netOperatingProfit);
    }

    const reportId = `REP-${assetId}-${periodLabel.replace(/\s+/g, "-")}-${Date.now()}`;
    const reportHash = ethers.keccak256(
      ethers.toUtf8Bytes(
        JSON.stringify({ reportId, assetId, periodLabel, gross, exp, distributableAmount })
      )
    );

    const record = await FinancialReport.create({
      reportId,
      assetId: Number(assetId),
      periodLabel,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      startTimestamp: startTs,
      endTimestamp: endTs,
      grossRentalIncome: gross,
      operatingExpenses: exp,
      maintenanceReserve: resv,
      netOperatingProfit,
      carriedForwardLoss: newLossCarryForward,
      distributableAmount,
      reportHash,
      status: "Draft",
      notes
    });

    res.status(201).json({ success: true, data: record });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/profit/reports/:reportId/approve
 * Approves a financial report for dividend distribution
 */
router.post("/reports/:reportId/approve", async (req, res) => {
  try {
    const { approverAddress } = req.body;
    const report = await FinancialReport.findOne({ reportId: req.params.reportId });

    if (!report) {
      return res.status(404).json({ success: false, message: "Report not found" });
    }

    await FinancialReport.updateOne(
      { reportId: req.params.reportId },
      {
        status: "Approved",
        approvedBy: approverAddress || "Admin",
        approvedAt: new Date()
      }
    );

    const updated = await FinancialReport.findOne({ reportId: req.params.reportId });
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/profit/calculate
 * Calculates time-weighted distribution against baseline snapshot
 */
router.post("/calculate", async (req, res) => {
  try {
    const { assetId, periodStart, periodEnd, distributableAmount, totalShares } = req.body;

    if (!assetId || !periodStart || !periodEnd || !distributableAmount || !totalShares) {
      return res.status(400).json({ success: false, message: "Missing required calculation parameters" });
    }

    // Sync latest blockchain ownership events
    await ownershipIndexer.syncEvents(0);

    const result = await profitCalculationService.computeProfitAllocations({
      assetId: Number(assetId),
      periodStart: Number(periodStart),
      periodEnd: Number(periodEnd),
      distributableAmount: Number(distributableAmount),
      totalShares: Number(totalShares),
      decimals: 6
    });

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
