import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";
import { Asset } from "../models/Asset.js";
import { TokenizationRecord } from "../models/TokenizationRecord.js";
import { syncAllWithChain } from "../services/chainSyncService.js";
import { protect } from "../middleware/auth.js";
import { requireDatabase } from "../middleware/requireDatabase.js";
import gasAnalyticsService from "../services/GasAnalyticsService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();
router.use("/assets", (req, res, next) =>
  req.query.mine === "true" ? requireDatabase(req, res, next) : next()
);

// Discovery does not depend on a seller creating an order or an available RPC.
router.get("/assets", (req, res, next) => req.query.mine === "true" ? protect(req, res, next) : next(), async (req, res) => {
  try {
    await syncAllWithChain();
    const [assets, records] = await Promise.all([
      Asset.find(req.user ? { ownerId: req.user.userId } : {}),
      TokenizationRecord.find({ tokenizationStatus: "TOKENIZED" }),
    ]);
    const confirmed = new Map(records.map(record => [Number(record.assetId), record]));
    const data = assets.filter(asset => asset.status === "Tokenized" || confirmed.has(Number(asset.assetId)))
      .map(asset => {
        const record = confirmed.get(Number(asset.assetId));
        return {
          assetId: asset.assetId,
          ownerId: asset.ownerId || null,
          tokenId: asset.blockchainAssetId ?? record?.tokenId ?? asset.assetId,
          name: asset.name || asset.assetName,
          symbol: asset.symbol,
          ownerWallet: asset.issuerWallet || asset.ownerAddress || record?.ownerWallet || "",
          assetType: asset.assetType,
          propertyType: asset.propertyType,
          location: asset.location,
          description: asset.description,
          imageUrl: asset.imageUrl,
          totalShares: record?.approvedTokenSupply ?? asset.totalShares,
        };
      });
    res.json({ success: true, count: data.length, data });
  } catch (err) {
    res.status(500).json({ success: false, message: "Unable to load tokenized assets" });
  }
});

function getMarketplaceContract() {
  try {
    const contractsPath = path.join(__dirname, "../contracts/deployedContracts.json");
    const contractsData = JSON.parse(fs.readFileSync(contractsPath, "utf8"));
    const config = contractsData.contracts?.TokenMarketplace;
    const provider = new ethers.JsonRpcProvider(process.env.BLOCKCHAIN_RPC_URL || "http://127.0.0.1:8545");
    return new ethers.Contract(config.address, config.abi, provider);
  } catch (err) {
    return null;
  }
}

/**
 * GET /api/marketplace/listings
 * Retrieves active or all listings from on-chain marketplace
 */
router.get("/listings", async (req, res) => {
  let contract;
  try {
    contract = getMarketplaceContract();
    if (!contract) {
      return res.status(503).json({ success: false, message: "Marketplace contract not configured" });
    }

    if (await contract.runner.getCode(await contract.getAddress()) === "0x") {
      return res.status(503).json({
        success: false,
        code: "MARKETPLACE_NOT_DEPLOYED",
        message: "Marketplace contract is not deployed on the configured network. Deploy the contracts and update deployedContracts.json.",
      });
    }
    const total = await contract.totalListings();
    const count = Number(total);
    const listings = [];

    for (let i = 1; i <= count; i++) {
      try {
        const item = await contract.getListing(i);
        const assetIdNum = Number(item.assetId);
        const assetDoc = await Asset.findOne({
          $or: [{ blockchainAssetId: assetIdNum }, { assetId: assetIdNum }]
        });

        listings.push({
          listingId: Number(item.listingId),
          seller: item.seller,
          assetId: assetIdNum,
          assetName: assetDoc?.name || assetDoc?.assetName || `Asset #${assetIdNum}`,
          assetSymbol: assetDoc?.symbol || `RWA-${assetIdNum}`,
          location: assetDoc?.location || "Sri Lanka",
          imageUrl: assetDoc?.imageUrl || "",
          totalShares: assetDoc?.totalShares || null,
          amount: Number(item.amount),
          pricePerTokenBase: item.pricePerToken.toString(),
          pricePerTokenFormatted: Number(ethers.formatUnits(item.pricePerToken, 6)),
          paymentToken: item.paymentToken,
          createdAt: Number(item.createdAt),
          expiresAt: Number(item.expiresAt),
          status: Number(item.status), // 0: Active, 1: Completed, 2: Cancelled
          statusLabel: ["Active", "Completed", "Cancelled"][Number(item.status)]
        });
      } catch (e) {
        // Skip invalid listings
      }
    }

    const { status, assetId } = req.query;
    let filtered = listings;
    if (status !== undefined) {
      filtered = filtered.filter((l) => l.status === Number(status));
    }
    if (assetId !== undefined) {
      filtered = filtered.filter((l) => l.assetId === Number(assetId));
    }

    res.json({ success: true, count: filtered.length, data: filtered });
  } catch (err) {
    res.status(503).json({
      success: false,
      code: "MARKETPLACE_UNAVAILABLE",
      message: "Unable to read the marketplace. Check BLOCKCHAIN_RPC_URL and the deployed marketplace contract.",
    });
  } finally {
    contract?.runner?.destroy();
  }
});

/**
 * POST /api/marketplace/track-tx
 * Records transaction gas and fee metrics
 */
router.post("/track-tx", async (req, res) => {
  try {
    const { txHash, operationType, payerAddress, payerCategory, assetId } = req.body;
    if (!txHash) {
      return res.status(400).json({ success: false, message: "txHash is required" });
    }

    const provider = new ethers.JsonRpcProvider(process.env.BLOCKCHAIN_RPC_URL || "http://127.0.0.1:8545");
    const receipt = await provider.getTransactionReceipt(txHash);

    if (!receipt) {
      return res.status(404).json({ success: false, message: "Transaction receipt not yet available" });
    }

    const metric = await gasAnalyticsService.recordTransactionGas({
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      operationType: operationType || "MarketplacePurchase",
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.gasPrice || receipt.effectiveGasPrice,
      payerAddress: payerAddress || receipt.from,
      payerCategory: payerCategory || "Investor",
      assetId
    });

    res.json({ success: true, data: metric });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
