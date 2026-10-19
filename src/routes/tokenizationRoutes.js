import express from "express";
import { VerifiedAssetService } from "../services/verifiedAssetService.js";
import { TokenPricingService } from "../services/tokenPricingService.js";
import blockchainReconciler from "../services/blockchainReconciliationService.js";
import { TokenizationRecord } from "../models/TokenizationRecord.js";
import { Asset } from "../models/Asset.js";

const router = express.Router();

/**
 * @route   GET /api/tokenization/verified-assets
 * @desc    Get verified assets eligible for tokenization, optionally filtered by ?owner=0x...
 */
router.get("/verified-assets", async (req, res) => {
  try {
    const ownerWallet = req.query.owner || null;
    const assets = await VerifiedAssetService.getVerifiedAssets(ownerWallet);
    res.json({
      success: true,
      count: assets.length,
      data: assets,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @route   GET /api/tokenization/preview/:assetId
 * @desc    Get locked tokenization parameters (valuation, total shares, calculated reference price)
 */
router.get("/preview/:assetId", async (req, res) => {
  try {
    const { assetId } = req.params;
    const callerWallet = req.query.callerWallet || null;
    const preview = await VerifiedAssetService.getTokenizationPreview(assetId, callerWallet);
    res.json({
      success: true,
      data: preview,
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * @route   GET /api/tokenization/status/:assetId
 * @desc    Get on-chain and database tokenization status, token ID, tx hash, and block number
 */
router.get("/status/:assetId", async (req, res) => {
  try {
    const { assetId } = req.params;
    const record = await TokenizationRecord.findOne({ assetId: Number(assetId) });

    let onChain = null;
    try {
      onChain = await blockchainReconciler.getOnChainAssetStatus(assetId);
    } catch (e) {
      // offline or not on-chain yet
    }

    res.json({
      success: true,
      data: {
        assetId: Number(assetId),
        databaseRecord: record,
        onChainStatus: onChain,
        isTokenized: (record && record.tokenizationStatus === "TOKENIZED") || (onChain && onChain.isTokenizedOnChain),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @route   GET /api/tokenization/ownership/:assetId/:walletAddress
 * @desc    Get authoritative on-chain token balance and percentage holding
 */
router.get("/ownership/:assetId/:walletAddress", async (req, res) => {
  try {
    const { assetId, walletAddress } = req.params;
    const ownership = await blockchainReconciler.getAuthoritativeTokenBalance(
      walletAddress,
      assetId
    );
    res.json({
      success: true,
      data: ownership,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @route   GET /api/tokenization/history
 * @desc    Get history of confirmed tokenization transactions and blockchain events
 */
router.get("/history", async (req, res) => {
  try {
    const ownerWallet = req.query.ownerWallet || null;
    const query = ownerWallet ? { ownerWallet } : {};
    const records = await TokenizationRecord.find(query);
    res.json({
      success: true,
      count: records.length,
      data: records,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @route   POST /api/tokenization/confirm
 * @desc    Verify transaction receipt from blockchain and record tokenization in Azure Cosmos DB
 */
router.post("/confirm", async (req, res) => {
  try {
    const { assetId, txHash, ownerWallet } = req.body;
    if (!assetId || !txHash) {
      return res.status(400).json({
        success: false,
        error: "assetId and txHash are required in request body",
      });
    }

    const result = await VerifiedAssetService.confirmTokenization({
      assetId,
      txHash,
      ownerWallet,
    });

    res.json(result);
  } catch (err) {
    console.error("Tokenization confirmation error:", err);
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * @route   POST /api/tokenization/revaluation
 * @desc    Records an approved asset revaluation and calculates updated reference price
 */
router.post("/revaluation", async (req, res) => {
  try {
    const { assetId, newValuationLKR, approvalRef, updatedBy } = req.body;
    if (!assetId || !newValuationLKR) {
      return res.status(400).json({
        success: false,
        error: "assetId and newValuationLKR are required",
      });
    }

    const asset = await Asset.findOne({ assetId: Number(assetId) });
    if (!asset) {
      return res.status(404).json({ success: false, error: "Asset not found" });
    }

    const currentVal = asset.valuationLKR || asset.valuation || 10000000;
    const shares = asset.totalShares || 1000;

    const reval = TokenPricingService.calculateRevaluation(
      currentVal,
      newValuationLKR,
      shares,
      approvalRef
    );

    // Update TokenizationRecord with historical revaluation record
    await TokenizationRecord.findOneAndUpdate(
      { assetId: Number(assetId) },
      {
        $set: {
          approvedValuation: newValuationLKR,
          calculatedReferencePrice: reval.newReferencePriceLKR,
        },
        $push: {
          historicalValuations: {
            valuation: newValuationLKR,
            referencePrice: reval.newReferencePriceLKR,
            effectiveDate: new Date(),
            approvalRef: approvalRef || "VERIFIER-UPDATE",
            updatedBy: updatedBy || "Authorized Verifier",
          },
        },
      }
    );

    // Update Asset model valuation
    await Asset.findOneAndUpdate(
      { assetId: Number(assetId) },
      {
        $set: {
          valuationLKR: newValuationLKR,
          valuation: newValuationLKR,
          sharePriceLKR: reval.newReferencePriceLKR,
        },
      }
    );

    res.json({
      success: true,
      message: "Approved valuation updated. New reference price calculated.",
      data: reval,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
