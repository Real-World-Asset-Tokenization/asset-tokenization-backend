import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";
import { Asset } from "../models/Asset.js";
import gasAnalyticsService from "../services/GasAnalyticsService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

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
  try {
    const contract = getMarketplaceContract();
    if (!contract) {
      return res.status(503).json({ success: false, message: "Marketplace contract not configured" });
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
    res.status(500).json({ success: false, message: err.message });
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
