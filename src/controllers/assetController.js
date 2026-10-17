import crypto from "crypto";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";

import { Asset } from "../models/Asset.js";
import User from "../models/User.js";
import DocumentHash from "../models/DocumentHash.js";
import aiService from "../services/aiService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The merged Asset model registers this Mongoose model.
// Use it for verification operations requiring populate(),
// findById(), and document.save().
const AssetModel = mongoose.models.Asset;

// ==========================================
// 1. UPLOAD ASSET DOCUMENTS
// ==========================================
export async function uploadAsset(req, res) {
  try {
    const { assetName, assetType, valuation, currency } = req.body;
    const userId = req.user.userId;

    const user = await User.findById(userId);

    if (!user || !user.isVerified) {
      return res.status(400).json({
        success: false,
        message: "User must be verified before uploading assets",
      });
    }

    const documents = {
      deed: null,
      surveyPlan: null,
      extracts: null,
      priorDeeds: null,
      certificates: null,
    };

    const fileFields = [
      "deed",
      "surveyPlan",
      "extracts",
      "priorDeeds",
      "certificates",
    ];

    for (const field of fileFields) {
      const file = req.files?.[field]?.[0];

      if (file) {
        documents[field] = {
          url: file.path,
          publicId: file.filename,
        };
      }
    }

    // Legacy single-document support.
    const legacyFile =
      req.files?.document?.[0] || req.file;

    if (legacyFile && !documents.deed) {
      documents.deed = {
        url: legacyFile.path,
        publicId: legacyFile.filename,
      };
    }

    if (!documents.deed || !documents.surveyPlan) {
      return res.status(400).json({
        success: false,
        message: "Deed and Survey Plan are required",
      });
    }

    // Generate required fields with defaults
    const assetIdNumber = Date.now() % 1000000; // Simple numeric ID
    const totalSharesVal = Number(req.body.totalShares) || 1;
    const valuationNum = Number(valuation) || 0;
    const sharePrice = totalSharesVal > 0 ? valuationNum / totalSharesVal : 0;

    const asset = await AssetModel.create({
      assetId: assetIdNumber,
      ownerId: userId,
      assetName,
      name: assetName,
      assetType,
      propertyType: assetType,
      location: req.body.location || "Unknown",
      document: documents.deed.url,
      documentPublicId: documents.deed.publicId,
      documents,
      valuation: valuationNum,
      valuationLKR: valuationNum,
      currency: currency || "LKR",
      verificationStatus: "pending",
      status: "Pending",
      issuerWallet: req.body.issuerWallet || "0x0000000000000000000000000000000000000000",
      symbol: req.body.symbol || assetName.substring(0, 4).toUpperCase(),
      totalShares: totalSharesVal,
      sharePriceLKR: sharePrice,
      metadataURI: req.body.metadataURI || `ipfs://placeholder-${assetIdNumber}`,
      documentHash:
        "0x" +
        crypto
          .createHash("sha256")
          .update(
            `${userId}-${Date.now()}-${assetName}`
          )
          .digest("hex"),
    });

    return res.status(201).json({
      success: true,
      message: "Asset documents uploaded successfully",
      data: {
        assetId: asset._id,
        assetName: asset.assetName,
        assetType: asset.assetType,
        valuation: asset.valuation,
        currency: asset.currency,
        verificationStatus: asset.verificationStatus,
        documents: Object.fromEntries(
          Object.entries(documents).map(([key, value]) => [
            key,
            Boolean(value),
          ])
        ),
      },
    });
  } catch (error) {
    console.error("Upload asset error:", error);

    return res.status(500).json({
      success: false,
      message: "Error uploading asset",
      error: error.message,
    });
  }
}

// ==========================================
// 2. VERIFY ASSET
// ==========================================
export async function verifyAsset(req, res) {
  let documentPath;

  const tempDir = path.resolve(__dirname, "../../temp");

  try {
    const { assetId } = req.params;
    const userId = req.user.userId;

    if (!mongoose.isValidObjectId(assetId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid asset ID",
      });
    }

    const asset = await AssetModel.findOne({
      _id: assetId,
      ownerId: userId,
    });

    if (!asset) {
      return res.status(404).json({
        success: false,
        message: "Asset not found",
      });
    }

    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const documentUrl =
      asset.documents?.deed?.url || asset.document;

    if (!documentUrl) {
      return res.status(400).json({
        success: false,
        message: "No document found for verification",
      });
    }

    fs.mkdirSync(tempDir, { recursive: true });

    const filename = `asset_${asset._id}_${Date.now()}.pdf`;
    documentPath = path.join(tempDir, filename);

    // Check if it's a local file path (Windows or Unix)
    if (documentUrl.match(/^[A-Za-z]:\\/) || documentUrl.startsWith('/')) {
      if (!fs.existsSync(documentUrl)) {
        return res.status(400).json({
          success: false,
          message: "Local document file not found",
        });
      }
      // Use the local file directly
      documentPath = documentUrl;
    } else {
      // Download from HTTPS URL
      if (!documentUrl.startsWith("https://")) {
        return res.status(400).json({
          success: false,
          message: "A secure HTTPS document URL is required",
        });
      }

      const response = await axios.get(documentUrl, {
        responseType: "arraybuffer",
        timeout: 30000,
        maxContentLength: 15 * 1024 * 1024,
        maxBodyLength: 15 * 1024 * 1024,
      });

      fs.writeFileSync(documentPath, response.data);
    }

    const pipelineResult =
      await aiService.runAssetDocumentPipeline(documentPath);

    await applyAssetPipelineResults(
      asset,
      pipelineResult,
      user
    );

    return res.status(200).json({
      success: true,
      message: "Asset verification completed",
      data: {
        assetId: asset._id,
        verificationStatus: asset.verificationStatus,
        documentAuthentic: asset.documentAuthentic,
        ownershipVerified: asset.ownershipVerified,
        ocrData: asset.ocrData,
        rejectionReason: asset.rejectionReason,
        aiGenerated: asset.aiGenerated,
        manipulationDetected: asset.manipulationDetected,
        duplicateOf: asset.duplicateOf,
        clarityScore: asset.clarityScore,
        riskScore: asset.riskScore,
        pipelineResults: asset.pipelineResults,
      },
    });
  } catch (error) {
    console.error("Verify asset error:", error);

    return res.status(500).json({
      success: false,
      message: "Error verifying asset",
      error: error.message,
    });
  } finally {
    // Only delete if it's a temp file (not the original local file)
    if (documentPath && fs.existsSync(documentPath) && documentPath.startsWith(tempDir)) {
      fs.unlinkSync(documentPath);
    }
  }
}

// ==========================================
// 3. GET ASSET VERIFICATION STATUS
// ==========================================
export async function getAssetStatus(req, res) {
  try {
    const assetId = req.params.assetId;

    if (!mongoose.isValidObjectId(assetId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid asset ID",
      });
    }

    const asset = await AssetModel.findOne({
      _id: assetId,
      ownerId: req.user.userId,
    });

    if (!asset) {
      return res.status(404).json({
        success: false,
        message: "Asset not found",
      });
    }

    return res.json({
      success: true,
      data: {
        assetId: asset._id,
        assetName: asset.assetName,
        assetType: asset.assetType,
        valuation: asset.valuation,
        currency: asset.currency,
        verificationStatus: asset.verificationStatus,
        documentAuthentic: asset.documentAuthentic,
        ownershipVerified: asset.ownershipVerified,
        ocrData: asset.ocrData,
        rejectionReason: asset.rejectionReason,
        createdAt: asset.createdAt,
        verifiedAt: asset.verifiedAt,
      },
    });
  } catch (error) {
    console.error("Get asset status error:", error);

    return res.status(500).json({
      success: false,
      message: "Error fetching asset status",
    });
  }
}

// ==========================================
// 4. GET USER ASSETS
// ==========================================
export async function getUserAssets(req, res) {
  try {
    const assets = await AssetModel.find({
      ownerId: req.user.userId,
    }).sort({ createdAt: -1 });

    return res.json({
      success: true,
      data: {
        assets: assets.map((asset) => ({
          assetId: asset._id,
          assetName: asset.assetName,
          assetType: asset.assetType,
          valuation: asset.valuation,
          currency: asset.currency,
          verificationStatus: asset.verificationStatus,
          createdAt: asset.createdAt,
        })),
        count: assets.length,
      },
    });
  } catch (error) {
    console.error("Get user assets error:", error);

    return res.status(500).json({
      success: false,
      message: "Error fetching user assets",
    });
  }
}

// ==========================================
// 5. COMPLIANCE: GET ALL ASSETS
// ==========================================
export async function getAllAssets(req, res) {
  try {
    const assets = await AssetModel.find({})
      .populate("ownerId", "name email role")
      .sort({ createdAt: -1 });

    return res.json({
      success: true,
      data: {
        assets: assets.map((asset) => ({
          assetId: asset._id,
          assetName: asset.assetName,
          assetType: asset.assetType,
          valuation: asset.valuation,
          currency: asset.currency,
          verificationStatus: asset.verificationStatus,
          documents: asset.documents,
          documentAuthentic: asset.documentAuthentic,
          ownershipVerified: asset.ownershipVerified,
          ocrData: asset.ocrData,
          rejectionReason: asset.rejectionReason,
          createdAt: asset.createdAt,
          verifiedAt: asset.verifiedAt,
          owner: asset.ownerId
            ? {
                id: asset.ownerId._id,
                name: asset.ownerId.name,
                email: asset.ownerId.email,
                role: asset.ownerId.role,
              }
            : null,
        })),
        count: assets.length,
      },
    });
  } catch (error) {
    console.error("Get all assets error:", error);

    return res.status(500).json({
      success: false,
      message: "Error fetching all assets",
    });
  }
}

// ==========================================
// 6. COMPLIANCE: GET ASSET DETAILS
// ==========================================
export async function getAssetDetails(req, res) {
  try {
    const { assetId } = req.params;

    if (!mongoose.isValidObjectId(assetId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid asset ID",
      });
    }

    const asset = await AssetModel.findById(assetId)
      .populate("ownerId", "name email role");

    if (!asset) {
      return res.status(404).json({
        success: false,
        message: "Asset not found",
      });
    }

    return res.json({
      success: true,
      data: {
        asset,
        owner: asset.ownerId
          ? {
              id: asset.ownerId._id,
              name: asset.ownerId.name,
              email: asset.ownerId.email,
              role: asset.ownerId.role,
            }
          : null,
      },
    });
  } catch (error) {
    console.error("Get asset details error:", error);

    return res.status(500).json({
      success: false,
      message: "Error fetching asset details",
    });
  }
}

// ==========================================
// 7. COMPLIANCE: UPDATE VERIFICATION STATUS
// ==========================================
export async function updateVerificationStatus(req, res) {
  try {
    const { assetId } = req.params;
    const { verificationStatus, rejectionReason } = req.body;

    if (!mongoose.isValidObjectId(assetId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid asset ID",
      });
    }

    const allowedStatuses = [
      "pending",
      "under_review",
      "approved",
      "rejected",
    ];

    if (!allowedStatuses.includes(verificationStatus)) {
      return res.status(400).json({
        success: false,
        message: "Invalid verification status",
      });
    }

    if (
      verificationStatus === "rejected" &&
      !String(rejectionReason || "").trim()
    ) {
      return res.status(400).json({
        success: false,
        message: "A rejection reason is required",
      });
    }

    const asset = await AssetModel.findById(assetId);

    if (!asset) {
      return res.status(404).json({
        success: false,
        message: "Asset not found",
      });
    }

    asset.verificationStatus = verificationStatus;
    asset.verifiedAt =
      verificationStatus === "approved"
        ? new Date()
        : undefined;

    asset.rejectionReason =
      verificationStatus === "rejected"
        ? rejectionReason
        : undefined;

    await asset.save();

    return res.json({
      success: true,
      message: "Verification status updated",
      data: {
        assetId: asset._id,
        verificationStatus: asset.verificationStatus,
        verifiedAt: asset.verifiedAt,
        rejectionReason: asset.rejectionReason,
      },
    });
  } catch (error) {
    console.error("Update verification status error:", error);

    return res.status(500).json({
      success: false,
      message: "Error updating verification status",
    });
  }
}

// ==========================================
// 8. BLOCKCHAIN: GET ASSETS
// ==========================================
export async function getAssets(req, res) {
  try {
    const filter = {};

    if (req.query.status) {
      filter.status = req.query.status;
    }

    if (req.query.issuer) {
      filter.issuerWallet = req.query.issuer;
    }

    const assets = await Asset.find(filter);

    return res.json({
      success: true,
      count: assets.length,
      data: assets,
    });
  } catch (error) {
    console.error("Get blockchain assets error:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}

// ==========================================
// 9. BLOCKCHAIN: GET ASSET BY NUMERIC ID
// ==========================================
export async function getAssetById(req, res) {
  try {
    const assetId = Number(req.params.id);

    if (!Number.isSafeInteger(assetId) || assetId < 1) {
      return res.status(400).json({
        success: false,
        error: "Invalid numeric asset ID",
      });
    }

    const asset = await Asset.findOne({ assetId });

    if (!asset) {
      return res.status(404).json({
        success: false,
        error: "Asset not found",
      });
    }

    return res.json({
      success: true,
      data: asset,
    });
  } catch (error) {
    console.error("Get blockchain asset error:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}

// ==========================================
// 10. BLOCKCHAIN: REGISTER ASSET
// ==========================================
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
      documentContent,
    } = req.body;

    if (
      !name ||
      !symbol ||
      !location ||
      !issuerWallet ||
      !ethersAddressIsValid(issuerWallet) ||
      !Number.isFinite(Number(valuationLKR)) ||
      Number(valuationLKR) <= 0 ||
      !Number.isSafeInteger(Number(totalShares)) ||
      Number(totalShares) <= 0
    ) {
      return res.status(400).json({
        success: false,
        error: "Invalid or missing asset registration fields",
      });
    }

    // Do not use client-supplied document text as proof that
    // legal ownership has been verified.
    const documentHash =
      "0x" +
      crypto
        .createHash("sha256")
        .update(
          documentContent ||
            `${name}-${location}-${valuationLKR}-${Date.now()}`
        )
        .digest("hex");

    const metadataURI = "";

    const newAsset = await Asset.create({
      name,
      assetName: name,
      symbol: symbol.toUpperCase(),
      propertyType: propertyType || "Residential Real Estate",
      assetType: "real_estate",
      location,
      description: description || "",
      valuationLKR: Number(valuationLKR),
      valuation: Number(valuationLKR),
      currency: "LKR",
      totalShares: Number(totalShares),
      sharePriceLKR: Number(
        Number(valuationLKR) / Number(totalShares)
      ),
      metadataURI,
      documentHash,
      imageUrl: imageUrl || "",
      issuerWallet: issuerWallet.toLowerCase(),
      status: "Pending",
      verificationStatus: "pending",
    });

    return res.status(201).json({
      success: true,
      message: "Asset registered and awaiting verification",
      data: newAsset,
    });
  } catch (error) {
    console.error("Register blockchain asset error:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}

// ==========================================
// 11. BLOCKCHAIN: UPDATE TOKENIZATION STATUS
// ==========================================
export async function updateBlockchainStatus(req, res) {
  try {
    const assetId = Number(req.params.id);
    const { status, txHash } = req.body;

    if (!Number.isSafeInteger(assetId) || assetId < 1) {
      return res.status(400).json({
        success: false,
        error: "Invalid numeric asset ID",
      });
    }

    const validStatuses = [
      "Pending",
      "Approved",
      "Tokenized",
      "Rejected",
    ];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: "Invalid blockchain asset status",
      });
    }

    // A blockchain asset cannot be tokenized until document
    // verification and compliance approval are complete.
    const asset = await Asset.findOne({ assetId });

    if (!asset) {
      return res.status(404).json({
        success: false,
        error: "Asset not found",
      });
    }

    if (
      status === "Tokenized" &&
      asset.verificationStatus !== "approved"
    ) {
      return res.status(400).json({
        success: false,
        error: "Asset verification approval is required first",
      });
    }

    const update = { status };

    if (txHash) {
      update.txHash = txHash;
    }

    if (status === "Tokenized") {
      update.tokenizedAt = new Date();
    }

    await Asset.updateOne(
      { assetId },
      { $set: update }
    );

    const updatedAsset = await Asset.findOne({ assetId });

    return res.json({
      success: true,
      message: `Asset status updated to ${status}`,
      data: updatedAsset,
    });
  } catch (error) {
    console.error("Update blockchain status error:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}

// ==========================================
// 12. PLATFORM STATISTICS
// ==========================================
export async function getPlatformStats(req, res) {
  try {
    const assets = await Asset.find({});

    const tokenized = assets.filter(
      (asset) => asset.status === "Tokenized"
    );

    return res.json({
      success: true,
      data: {
        totalAssets: assets.length,

        tokenizedAssetsCount: tokenized.length,

        pendingVerificationCount: assets.filter(
          (asset) =>
            asset.verificationStatus === "pending" ||
            asset.status === "Pending"
        ).length,

        totalValuationLKR: assets.reduce(
          (sum, asset) =>
            sum + Number(asset.valuationLKR || 0),
          0
        ),

        tokenizedValuationLKR: tokenized.reduce(
          (sum, asset) =>
            sum + Number(asset.valuationLKR || 0),
          0
        ),

        totalFractionalShares: tokenized.reduce(
          (sum, asset) =>
            sum + Number(asset.totalShares || 0),
          0
        ),
      },
    });
  } catch (error) {
    console.error("Platform statistics error:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}

// ==========================================
// 13. PRIVATE: DOCUMENT HASH DUPLICATE CHECK
// ==========================================
async function checkDocumentHashDuplicate(hash, assetId) {
  const existing = await DocumentHash.findOne({ hash });

  if (
    existing &&
    existing.assetId.toString() !== assetId.toString()
  ) {
    return {
      isDuplicate: true,
      duplicateAssetId: existing.assetId,
    };
  }

  return { isDuplicate: false };
}

// ==========================================
// 14. PRIVATE: APPLY AI PIPELINE RESULTS
// ==========================================
async function applyAssetPipelineResults(
  asset,
  pipelineResult,
  user
) {
  const stages = pipelineResult.stages || {};

  const clarity = stages.stage1_clarity;
  const aiGeneration = stages.stage2_ai_generation;
  const manipulation = stages.stage3_manipulation;
  const hashStage = stages.stage4_hash;
  const ocr = stages.stage5_ocr;
  const risk = stages.stage6_risk;

  if (clarity) {
    asset.clarityScore = clarity.qualityScore ?? 0;
    asset.documentAuthentic = clarity.passed === true;
  }

  if (aiGeneration) {
    asset.aiGenerated = aiGeneration.is_generated === true;
  }

  if (manipulation) {
    asset.manipulationDetected =
      manipulation.manipulationDetected === true;
  }

  if (hashStage?.hash) {
    const duplicate = await checkDocumentHashDuplicate(
      hashStage.hash,
      asset._id
    );

    asset.documentHash = hashStage.hash;

    if (duplicate.isDuplicate) {
      asset.duplicateOf = duplicate.duplicateAssetId;
    } else {
      asset.duplicateOf = null;

      await DocumentHash.create({
        hash: hashStage.hash,
        assetId: asset._id,
        ownerId: asset.ownerId,
        uploadDate: new Date(),
      });
    }
  }

  if (ocr?.extractedData) {
    asset.ocrData = ocr.extractedData;

    const ownerName = asset.ocrData.ownerName;
    const userName = user.name;

    if (ownerName && userName) {
      asset.ownershipVerified =
        ownerName.trim().toLowerCase() ===
        userName.trim().toLowerCase();
    }
  }

  if (risk) {
    asset.riskScore = risk.riskScore ?? 0;

    const factors = risk.factors || {};
    const reasons = [];

    if (factors.documentClarity?.score < 10) {
      reasons.push("Poor document quality");
    }

    if (asset.aiGenerated) {
      reasons.push("AI-generated document detected");
    }

    if (asset.manipulationDetected) {
      reasons.push("Document manipulation detected");
    }

    if (asset.duplicateOf) {
      reasons.push("Duplicate document detected");
    }

    if (!asset.ownershipVerified) {
      reasons.push("Ownership validation failed");
    }

    if (risk.decision === "approved") {
      // AI output alone should not be treated as legal title
      // confirmation. Require human compliance approval.
      asset.verificationStatus = "under_review";
      asset.rejectionReason =
        "AI checks passed; awaiting compliance approval";
    } else if (risk.decision === "under_review") {
      asset.verificationStatus = "under_review";
      asset.rejectionReason = reasons.join("; ");
    } else {
      asset.verificationStatus = "rejected";
      asset.rejectionReason =
        reasons.join("; ") || "Verification failed";
    }
  }

  asset.pipelineResults = {
    pipelineVersion: pipelineResult.pipelineVersion,
    pipelineRunAt: new Date(),
    finalDecision: pipelineResult.finalDecision,
    abortedAt: pipelineResult.abortedAt || null,
    abortReason: pipelineResult.abortReason || null,
    stage1_clarity: stages.stage1_clarity || null,
    stage2_ai_generation: stages.stage2_ai_generation || null,
    stage3_manipulation: stages.stage3_manipulation || null,
    stage4_hash: stages.stage4_hash || null,
    stage5_ocr: stages.stage5_ocr || null,
    stage6_risk: stages.stage6_risk || null,
  };

  await asset.save();
}

// ==========================================
// 15. PRIVATE: ETHEREUM ADDRESS VALIDATION
// ==========================================
function ethersAddressIsValid(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}