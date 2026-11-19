import express from "express";
import DistributionRound from "../models/DistributionRound.js";
import InvestorAllocation from "../models/InvestorAllocation.js";
import merkleDistributionService from "../services/MerkleDistributionService.js";
import distributionCoordinator from "../services/DistributionCoordinator.js";
import { protect, authorize } from "../middleware/auth.js";
import { requireDatabase } from "../middleware/requireDatabase.js";
import User from "../models/User.js";
import { asString } from "../config/security.js";

const adminOnly = [protect, authorize("admin", "compliance_officer")];

const router = express.Router();
router.use(requireDatabase);

/**
 * GET /api/distribution/rounds
 * Lists all distribution rounds
 */
router.get("/rounds", async (req, res) => {
  try {
    const filter = {};
    if (req.query.assetId) {
      filter.assetId = Number(req.query.assetId);
    }
    const rounds = await DistributionRound.find(filter);
    res.json({ success: true, count: rounds.length, data: rounds });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/distribution/rounds/:roundId
 * Gets specific round with allocations summary
 */
router.get("/rounds/:roundId", async (req, res) => {
  try {
    const round = await DistributionRound.findOne({ roundId: Number(req.params.roundId) });
    if (!round) {
      return res.status(404).json({ success: false, message: "Round not found" });
    }
    const allocations = await InvestorAllocation.find({ roundId: Number(req.params.roundId) });
    res.json({ success: true, data: { round, allocations } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/distribution/claim-proof/:roundId/:wallet
 * Retrieves the cryptographic Merkle proof and claim details for an investor
 */
router.get("/claim-proof/:roundId/:wallet", async (req, res) => {
  try {
    const { roundId, wallet } = req.params;
    const proofData = await merkleDistributionService.getInvestorClaimProof(roundId, wallet);

    if (!proofData) {
      return res.status(404).json({
        success: false,
        message: "No dividend allocation found for this wallet in round #" + roundId
      });
    }

    res.json({ success: true, data: proofData });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/distribution/execute
 * Automates the distribution round preparation and on-chain publication
 */
router.post("/execute", adminOnly, async (req, res) => {
  try {
    const { reportId, assetId, periodLabel, periodStart, periodEnd, distributableAmount, reportHash, autoPublishOnChain = false } = req.body;

    if (!reportId && (!assetId || !periodLabel || !periodStart || !periodEnd || !(Number(distributableAmount) > 0))) {
      return res.status(400).json({ success: false, message: "Provide an approved reportId, or assetId, periodLabel, periodStart, periodEnd and distributableAmount" });
    }

    // totalShares is read from the chain; a client-supplied value is ignored.
    const result = await distributionCoordinator.prepareAndPublishDistribution({
      reportId,
      assetId: Number(assetId),
      periodLabel,
      periodStart: Number(periodStart),
      periodEnd: Number(periodEnd),
      distributableAmount: Number(distributableAmount),
      reportHash,
      autoPublishOnChain: Boolean(autoPublishOnChain)
    });

    res.status(autoPublishOnChain ? 201 : 200).json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, message: err.shortMessage || err.message });
  }
});

/**
 * POST /api/distribution/mark-claimed
 * Updates local database status after successful on-chain claim
 */
router.post("/mark-claimed", protect, async (req, res) => {
  try {
    const roundId = Number(req.body.roundId);
    const wallet = asString(req.body.walletAddress).toLowerCase().trim();
    const txHash = asString(req.body.txHash);
    if (!Number.isSafeInteger(roundId) || !/^0x[a-f0-9]{40}$/.test(wallet)) {
      return res.status(400).json({ success: false, message: "roundId and a valid walletAddress are required" });
    }

    // Only the wallet's owner (or an operator) may record a claim for it.
    const account = await User.findById(req.user.userId).select("walletAddress role").lean();
    const isOperator = ["admin", "compliance_officer"].includes(account?.role);
    if (!isOperator && account?.walletAddress !== wallet) {
      return res.status(403).json({ success: false, message: "You can only record claims for your own wallet" });
    }

    await InvestorAllocation.updateOne(
      { roundId, walletAddress: wallet },
      {
        isClaimed: true,
        claimedAt: new Date(),
        txHashClaim: txHash
      }
    );

    res.json({ success: true, message: "Allocation marked as claimed" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
