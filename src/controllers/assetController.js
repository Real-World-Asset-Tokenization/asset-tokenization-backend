import crypto from "crypto";
import { Asset } from "../models/Asset.js";

export async function getAssets(req, res) {
  try {
    const { status, issuer } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (issuer) filter.issuerWallet = issuer;

    const assets = await Asset.find(filter);
    res.json({ success: true, count: assets.length, data: assets });
  } catch (error) {
    console.error("Error fetching assets:", error);
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function getAssetById(req, res) {
  try {
    const assetId = Number(req.params.id);
    const asset = await Asset.findOne({ assetId });

    if (!asset) {
      return res.status(404).json({ success: false, error: "Asset not found" });
    }

    res.json({ success: true, data: asset });
  } catch (error) {
    console.error("Error fetching asset details:", error);
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function registerAsset(req, res) {
  try {
    const {
      name,
      symbol,
      propertyType,
      location,
      description,
      valuationLKR,
      totalShares,
      imageUrl,
      issuerWallet,
      documentContent
    } = req.body;

    if (!name || !symbol || !valuationLKR || !totalShares || !issuerWallet) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields (name, symbol, valuationLKR, totalShares, issuerWallet)"
      });
    }

    // Compute cryptographic SHA-256 document hash for legal title deed integrity
    const docData = documentContent || `${name}-${location}-${valuationLKR}-${Date.now()}`;
    const documentHash = "0x" + crypto.createHash("sha256").update(docData).digest("hex");

    // Simulated IPFS Metadata CID
    const metadataCID = "ipfs://bafybei" + crypto.createHash("sha256").update(JSON.stringify({ name, symbol, location, valuationLKR })).digest("hex").slice(0, 46);

    const sharePriceLKR = Math.round(Number(valuationLKR) / Number(totalShares));

    const newAsset = await Asset.create({
      name,
      symbol: symbol.toUpperCase(),
      propertyType: propertyType || "Residential Real Estate",
      location,
      description: description || "",
      valuationLKR: Number(valuationLKR),
      totalShares: Number(totalShares),
      sharePriceLKR,
      metadataURI: metadataCID,
      documentHash,
      imageUrl: imageUrl || "https://images.unsplash.com/photo-1545324418-cc1a3fa10c00?auto=format&fit=crop&w=1200&q=80",
      issuerWallet: issuerWallet.toLowerCase(),
      status: "Pending"
    });

    res.status(201).json({
      success: true,
      message: "Asset registered successfully. Pending legal deed verification.",
      data: newAsset
    });
  } catch (error) {
    console.error("Error creating asset:", error);
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function updateAssetStatus(req, res) {
  try {
    const assetId = Number(req.params.id);
    const { status, txHash } = req.body;

    if (!["Pending", "Approved", "Tokenized", "Rejected"].includes(status)) {
      return res.status(400).json({ success: false, error: "Invalid status value" });
    }

    const update = { status };
    if (txHash) update.txHash = txHash;
    if (status === "Tokenized") update.tokenizedAt = new Date();

    const result = await Asset.updateOne({ assetId }, { $set: update });

    if (result.modifiedCount === 0) {
      return res.status(404).json({ success: false, error: "Asset not found or status unchanged" });
    }

    const updatedAsset = await Asset.findOne({ assetId });
    res.json({
      success: true,
      message: `Asset status updated to ${status}`,
      data: updatedAsset
    });
  } catch (error) {
    console.error("Error updating asset status:", error);
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function getPlatformStats(req, res) {
  try {
    const allAssets = await Asset.find({});
    const tokenizedAssets = allAssets.filter(a => a.status === "Tokenized");

    const totalValuationLKR = allAssets.reduce((acc, curr) => acc + (curr.valuationLKR || 0), 0);
    const tokenizedValuationLKR = tokenizedAssets.reduce((acc, curr) => acc + (curr.valuationLKR || 0), 0);
    const totalFractionalShares = tokenizedAssets.reduce((acc, curr) => acc + (curr.totalShares || 0), 0);

    res.json({
      success: true,
      data: {
        totalAssets: allAssets.length,
        tokenizedAssetsCount: tokenizedAssets.length,
        pendingVerificationCount: allAssets.filter(a => a.status === "Pending").length,
        totalValuationLKR,
        tokenizedValuationLKR,
        totalFractionalShares
      }
    });
  } catch (error) {
    console.error("Error fetching stats:", error);
    res.status(500).json({ success: false, error: error.message });
  }
}
