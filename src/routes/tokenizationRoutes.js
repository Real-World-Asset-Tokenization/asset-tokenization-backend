import express from "express";
import { VerifiedAssetService } from "../services/verifiedAssetService.js";
import { TokenPricingService } from "../services/tokenPricingService.js";
import blockchainReconciler from "../services/blockchainReconciliationService.js";
import { TokenizationRecord } from "../models/TokenizationRecord.js";
import { Asset } from "../models/Asset.js";
import { protect, authorize } from "../middleware/auth.js";
import { syncAllWithChain, chainStatusFor, chainStateOf, invalidateChainSync } from "../services/chainSyncService.js";
import blockchainService from "../services/blockchainService.js";
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const deployedPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../contracts/deployedContracts.json");


import { requireDatabase } from "../middleware/requireDatabase.js";

const router = express.Router();
// Account-specific data must never be answered from unrelated demo seeds.
router.use((req, res, next) => {
  if (req.path === "/verified-assets" && req.query.mine !== "true" && !req.query.owner) return next();
  if (req.method === "GET" && req.path.startsWith("/valuation/")) return next(); // reads the chain only
  return requireDatabase(req, res, next);
});

/**
 * @route   GET /api/tokenization/verified-assets
 * @desc    Get verified assets eligible for tokenization, optionally filtered by ?owner=0x...
 */
router.get("/verified-assets", (req, res, next) => req.query.mine === "true" ? protect(req, res, next) : next(), async (req, res) => {
  try {
    const ownerWallet = req.user ? null : req.query.owner || null;
    const states = await syncAllWithChain();
    const assets = (await VerifiedAssetService.getVerifiedAssets(ownerWallet, req.user?.userId || null))
      .map((a) => {
        const chainStatus = chainStatusFor(states, a.assetId);
        // The chain decides: only a confirmed on-chain asset counts as tokenized.
        const tokenized = states ? chainStatus === "tokenized" : a.tokenizationStatus === "TOKENIZED";
        return { ...a, chainStatus, tokenizationStatus: tokenized ? "TOKENIZED" : "VERIFIED_ELIGIBLE", isEligibleForTokenization: a.verificationStatus === "APPROVED" && !tokenized };
      });
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
 * @route   POST /api/tokenization/chain-approve/:assetId
 * @desc    After the owner re-registers an asset on the chain (e.g. after a chain reset),
 *          approve it in the registry. Only for the asset's owner, and only when the
 *          compliance document review was already approved in Azure.
 */
router.post("/chain-approve/:assetId", protect, async (req, res) => {
  try {
    const asset = await Asset.findOne({ assetId: Number(req.params.assetId) });
    if (!asset) return res.status(404).json({ success: false, error: "Asset not found" });
    if (String(asset.ownerId) !== String(req.user.userId)) return res.status(403).json({ success: false, error: "Only the asset owner can do this" });
    if (asset.verificationStatus !== "approved") {
      return res.status(409).json({ success: false, error: "The compliance team has not approved this asset's documents yet." });
    }
    const registry = blockchainReconciler.getAssetRegistryContract();
    const token = blockchainReconciler.getAssetTokenContract();
    const ctx = {
      idsByIssuer: (w) => registry.getAssetsByIssuer(w),
      record: (id) => registry.getAsset(id),
      isTokenized: (id) => token.isTokenized(id),
    };
    const { state, chainId } = await chainStateOf(asset, ctx);
    if (state === "missing") return res.status(409).json({ success: false, error: "This asset is not registered on the current blockchain yet. Register it from your wallet first." });
    if (state === "rejected") return res.status(409).json({ success: false, error: "The blockchain registry rejected this asset." });
    if (state === "pending") {
      const result = await blockchainService.approveAsset(chainId);
      if (!result?.success) throw new Error(result?.error || "Registry approval failed");
    }
    await Asset.findOneAndUpdate({ assetId: Number(asset.assetId) }, { $set: { blockchainAssetId: chainId, status: state === "tokenized" ? "Tokenized" : "Approved" } });
    invalidateChainSync();
    res.json({ success: true, data: { assetId: Number(asset.assetId), blockchainAssetId: chainId, chainStatus: state === "tokenized" ? "tokenized" : "approved" } });
  } catch (err) {
    res.status(502).json({ success: false, error: err.shortMessage || err.message });
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
    const asset = await Asset.findOne({ assetId: Number(assetId) });
    const tokenId = asset?.blockchainAssetId ?? record?.tokenId ?? Number(assetId);

    let onChain = null;
    try {
      onChain = await blockchainReconciler.getOnChainAssetStatus(tokenId);
    } catch (e) {
      // offline or not on-chain yet
    }

    res.json({
      success: true,
      data: {
        assetId: Number(assetId),
        databaseRecord: record ? { ...(record.toObject ? record.toObject() : record), tokenId } : null,
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
 * @route   GET /api/tokenization/valuation/:assetId?wallet=0x...
 * @desc    Current on-chain value, price per token, change history and (optionally) a wallet's holding value
 */
router.get("/valuation/:assetId", async (req, res) => {
  try {
    const id = Number(req.params.assetId);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ success: false, error: "Invalid assetId" });
    const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf8"));
    const provider = new ethers.JsonRpcProvider(process.env.BLOCKCHAIN_RPC_URL || "http://127.0.0.1:8545");
    const registry = new ethers.Contract(deployed.contracts.AssetRegistry.address, deployed.contracts.AssetRegistry.abi, provider);
    const token = new ethers.Contract(deployed.contracts.AssetToken.address, deployed.contracts.AssetToken.abi, provider);

    const a = await registry.getAsset(id);
    const valuation = Number(a.valuationLKR);
    const shares = Number(a.totalShares);
    const events = await registry.queryFilter(registry.filters.AssetValuationUpdated(id));
    const data = {
      assetId: id,
      name: a.name,
      status: ["Pending", "Approved", "Tokenized", "Rejected"][Number(a.status)],
      valuationLKR: valuation,
      totalShares: shares,
      pricePerTokenLKR: valuation / shares,
      history: events.map((e) => ({
        oldValuationLKR: Number(e.args.oldValuationLKR),
        newValuationLKR: Number(e.args.newValuationLKR),
        changePercent: Number(((Number(e.args.newValuationLKR) / Number(e.args.oldValuationLKR) - 1) * 100).toFixed(2)),
        date: new Date(Number(e.args.timestamp) * 1000).toISOString(),
        txHash: e.transactionHash,
      })),
    };
    if (req.query.wallet) {
      if (!ethers.isAddress(req.query.wallet)) return res.status(400).json({ success: false, error: "Invalid wallet" });
      const tokens = Number(await token.balanceOf(req.query.wallet, id));
      data.holding = { wallet: req.query.wallet, tokens, valueLKR: (valuation * tokens) / shares };
    }
    res.json({ success: true, data });
  } catch (err) {
    res.status(err.shortMessage?.includes("revert") ? 404 : 500).json({ success: false, error: err.reason || err.shortMessage || err.message });
  }
});

/**
 * @route   POST /api/tokenization/revaluation
 * @desc    Retired: valuations now go through proposal -> approval -> publication.
 */
router.post("/revaluation", (req, res) => {
  res.status(410).json({
    success: false,
    error: "Direct revaluation is disabled. Submit a proposal to POST /api/valuations/proposals; an approver then approves and publishes it.",
  });
});

export default router;
