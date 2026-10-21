import express from "express";
import { ethers } from "ethers";
import FinancialReport from "../models/FinancialReport.js";
import profitCalculationService from "../services/ProfitCalculationService.js";
import ownershipIndexer from "../services/OwnershipIndexer.js";
import { protect, authorize } from "../middleware/auth.js";

const adminOnly = [protect, authorize("admin", "compliance_officer")];

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
router.post("/reports", adminOnly, async (req, res) => {
  try {
    const {
      assetId,
      periodLabel,
      startDate,
      endDate,
      grossRentalIncome,
      operatingExpenses,
      maintenanceReserve = 0,
      notes = ""
    } = req.body;

    if (!assetId || !periodLabel || !startDate || !endDate) {
      return res.status(400).json({ success: false, message: "Missing required report parameters" });
    }

    const startTs = Math.floor(new Date(startDate).getTime() / 1000);
    const endTs = Math.floor(new Date(endDate).getTime() / 1000);
    if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || endTs <= startTs) {
      return res.status(400).json({ success: false, message: "End date must be after start date" });
    }

    const gross = Number(grossRentalIncome) || 0;
    const exp = Number(operatingExpenses) || 0;
    const resv = Number(maintenanceReserve) || 0;
    if (gross < 0 || exp < 0 || resv < 0) {
      return res.status(400).json({ success: false, message: "Income, expenses and reserve cannot be negative" });
    }

    // A loss from the asset's previous report must be recovered before new profit is paid out.
    const previous = (await FinancialReport.find({ assetId: Number(assetId) }))
      .filter((r) => r.status === "Approved" && r.endTimestamp <= startTs)
      .sort((a, b) => b.endTimestamp - a.endTimestamp)[0];
    const priorLoss = previous ? Number(previous.carriedForwardLoss) || 0 : 0;

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
      priorLossApplied: priorLoss,
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
router.post("/reports/:reportId/approve", adminOnly, async (req, res) => {
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
        approvedBy: approverAddress || req.user.userId,
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
router.post("/calculate", adminOnly, async (req, res) => {
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
