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
import blockchainService from "../services/blockchainService.js";
import notificationService from "../services/notificationService.js";
import spvService from "../services/spvService.js";
import ownershipTransferService from "../services/ownershipTransferService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper function to convert local file path to HTTP URL
const convertToHttpUrl = (filePath) => {
  if (!filePath) return null;
  
  // If it's already an HTTP URL, return as-is
  if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
    return filePath;
  }
  
  // Extract filename from local path
  const filename = path.basename(filePath);
  
  // Return HTTP URL
  return `http://localhost:5001/uploads/${filename}`;
};

// The merged Asset model registers this Mongoose model.
// Use it for verification operations requiring populate(),
// findById(), and document.save().
const AssetModel = mongoose.models.Asset;

// ==========================================
// 1. UPLOAD ASSET DOCUMENTS
// ==========================================
export async function uploadAsset(req, res) {
  try {
    const { assetName, assetType, valuation, currency, location, latitude, longitude, address } = req.body;
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
          url: convertToHttpUrl(file.path),
          publicId: file.filename,
        };
      }
    }

    // Legacy single-document support.
    const legacyFile =
      req.files?.document?.[0] || req.file;

    if (legacyFile && !documents.deed) {
      documents.deed = {
        url: convertToHttpUrl(legacyFile.path),
        publicId: legacyFile.filename,
      };
    }

    if (!documents.deed || !documents.surveyPlan) {
      return res.status(400).json({
        success: false,
        message: "Deed and Survey Plan are required",
      });
    }

    // Handle asset images (up to 5)
    const images = [];
    const imageFiles = req.files?.images || [];
    const maxImages = 5;

    for (let i = 0; i < Math.min(imageFiles.length, maxImages); i++) {
      const file = imageFiles[i];
      if (file) {
        images.push({
          url: convertToHttpUrl(file.path),
          publicId: file.filename,
        });
      }
    }

    // Use the first image as the main imageUrl for compatibility
    const mainImageUrl = images.length > 0 ? images[0].url : "";

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
      location: location || "Unknown",
      coordinates: {
        latitude: latitude ? Number(latitude) : null,
        longitude: longitude ? Number(longitude) : null,
        address: address || "",
      },
      document: documents.deed.url,
      documentPublicId: documents.deed.publicId,
      documents,
      images,
      imageUrl: mainImageUrl,
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
        images: images.map(img => img.url),
        coordinates: asset.coordinates,
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
    } else if (documentUrl.startsWith('http://localhost') || documentUrl.startsWith('http://127.0.0.1')) {
      // Convert HTTP URL to local file path
      const filename = path.basename(documentUrl);
      const localPath = path.join(__dirname, '../../uploads', filename);
      
      if (!fs.existsSync(localPath)) {
        return res.status(400).json({
          success: false,
          message: "Local document file not found",
        });
      }
      documentPath = localPath;
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
        assets: assets.map((asset) => {
          const assetObj = asset.toObject();
          
          // Convert document URLs to HTTP URLs
          if (assetObj.documents) {
            for (const key in assetObj.documents) {
              if (assetObj.documents[key]?.url) {
                assetObj.documents[key].url = convertToHttpUrl(assetObj.documents[key].url);
              }
            }
          }
          
          return {
            assetId: asset._id,
            assetName: asset.assetName,
            assetType: asset.assetType,
            valuation: asset.valuation,
            currency: asset.currency,
            verificationStatus: asset.verificationStatus,
            status: asset.status,
            documentAuthentic: asset.documentAuthentic,
            ownershipVerified: asset.ownershipVerified,
            tokenizationConsent: asset.tokenizationConsent,
            spvCreated: asset.spvCreated,
            ownershipTransferred: asset.ownershipTransferred,
            spvDetails: asset.spvDetails,
            riskScore: asset.riskScore,
            rejectionReason: asset.rejectionReason,
            documents: assetObj.documents,
            images: assetObj.images?.map(img => ({
              url: convertToHttpUrl(img.url),
              publicId: img.publicId,
            })) || [],
            imageUrl: assetObj.imageUrl ? convertToHttpUrl(assetObj.imageUrl) : "",
            coordinates: assetObj.coordinates,
            createdAt: asset.createdAt,
          };
        }),
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
        assets: assets.map((asset) => {
          const assetObj = asset.toObject();
          
          // Convert document URLs to HTTP URLs
          if (assetObj.documents) {
            for (const key in assetObj.documents) {
              if (assetObj.documents[key]?.url) {
                assetObj.documents[key].url = convertToHttpUrl(assetObj.documents[key].url);
              }
            }
          }
          
          return {
            assetId: asset._id,
            assetName: asset.assetName,
            assetType: asset.assetType,
            valuation: asset.valuation,
            currency: asset.currency,
            verificationStatus: asset.verificationStatus,
            documents: assetObj.documents,
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
          };
        }),
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

    // Convert document URLs to HTTP URLs for frontend access
    const assetWithHttpUrls = asset.toObject();
    if (assetWithHttpUrls.documents) {
      for (const key in assetWithHttpUrls.documents) {
        if (assetWithHttpUrls.documents[key]?.url) {
          assetWithHttpUrls.documents[key].url = convertToHttpUrl(assetWithHttpUrls.documents[key].url);
        }
      }
    }
    if (assetWithHttpUrls.document) {
      assetWithHttpUrls.document = convertToHttpUrl(assetWithHttpUrls.document);
    }

    return res.json({
      success: true,
      data: {
        asset: assetWithHttpUrls,
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

    // If approved, notify asset owner and set status to awaiting consent
    if (verificationStatus === "approved") {
      try {
        console.log(`[Asset Controller] Asset ${assetId} approved by compliance officer`);

        // Set document and ownership verification flags to true upon approval
        // This ensures the UI displays "Yes" for these fields after compliance approval
        asset.documentAuthentic = true;
        asset.ownershipVerified = true;

        // Update asset status to await owner consent
        asset.status = "awaiting_consent";
        await asset.save();

        // Send notification to asset owner
        await notificationService.sendApprovalNotification(
          asset.ownerId,
          asset._id,
          asset.assetName || asset.name
        );

        console.log(`[Asset Controller] Asset owner notified, awaiting consent`);
      } catch (notificationError) {
        console.error(`[Asset Controller] Error sending notification:`, notificationError);
        // Don't fail the approval if notification fails
      }
    } else if (verificationStatus === "rejected") {
      // Send rejection notification
      try {
        await notificationService.sendRejectionNotification(
          asset.ownerId,
          asset._id,
          asset.assetName || asset.name,
          rejectionReason
        );
      } catch (notificationError) {
        console.error(`[Asset Controller] Error sending rejection notification:`, notificationError);
      }
    }

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
// 8. ASSET OWNER: CONFIRM TOKENIZATION CONSENT
// ==========================================
export async function confirmTokenizationConsent(req, res) {
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

    if (asset.verificationStatus !== "approved" && asset.status !== "awaiting_consent") {
      return res.status(400).json({
        success: false,
        message: "Asset must be approved before providing consent",
      });
    }

    if (asset.tokenizationConsent) {
      // Return current status instead of error
      const responseMessage = asset.status === 'ready_for_tokenization'
        ? "Consent already provided. Asset is ready for blockchain tokenization (pending blockchain node)."
        : asset.status === 'Tokenized'
        ? "Consent already provided. Asset has been fully tokenized."
        : "Consent already provided. Tokenization is in progress.";

      return res.json({
        success: true,
        message: responseMessage,
        data: {
          assetId: asset._id,
          tokenizationConsent: asset.tokenizationConsent,
          tokenizationConsentAt: asset.tokenizationConsentAt,
          spvDetails: asset.spvDetails,
          status: asset.status,
          alreadyProvided: true,
        },
      });
    }

    // Update asset with consent
    asset.tokenizationConsent = true;
    asset.tokenizationConsentAt = new Date();
    asset.status = "spv_creation";
    await asset.save();

    console.log(`[Asset Controller] Consent provided for asset ${assetId} by user ${userId}`);

    // Trigger SPV creation
    const spvResult = await createSPVForAsset(asset, userId);

    if (!spvResult.success) {
      // Revert consent if SPV creation fails
      asset.tokenizationConsent = false;
      asset.tokenizationConsentAt = undefined;
      asset.status = "awaiting_consent";
      await asset.save();

      return res.status(500).json({
        success: false,
        message: "Consent recorded but SPV creation failed",
        error: spvResult.error,
      });
    }

    // Refresh asset data to get updated status
    const updatedAsset = await AssetModel.findById(asset._id);

    const responseMessage = spvResult.blockchainSkipped
      ? "Consent recorded, SPV created, ownership transferred. Blockchain tokenization pending (node not running)."
      : "Consent recorded and full tokenization workflow completed";

    return res.json({
      success: true,
      message: responseMessage,
      data: {
        assetId: updatedAsset._id,
        tokenizationConsent: updatedAsset.tokenizationConsent,
        tokenizationConsentAt: updatedAsset.tokenizationConsentAt,
        spvDetails: updatedAsset.spvDetails,
        status: updatedAsset.status,
        blockchainSkipped: spvResult.blockchainSkipped || false,
      },
    });
  } catch (error) {
    console.error("Confirm tokenization consent error:", error);

    return res.status(500).json({
      success: false,
      message: "Error confirming tokenization consent",
      error: error.message,
    });
  }
}

// ==========================================
// 9. GET TOKENIZATION STATUS
// ==========================================
export async function getTokenizationStatus(req, res) {
  try {
    const { assetId } = req.params;

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

    // Determine current step
    // If status is ready_for_tokenization or Tokenized, mark all steps as complete
    const isReadyOrTokenized = asset.status === "ready_for_tokenization" || asset.status === "Tokenized";

    const steps = {
      documentApproved: asset.verificationStatus === "approved",
      ownerConsent: asset.tokenizationConsent || isReadyOrTokenized,
      spvCreated: asset.spvCreated || isReadyOrTokenized,
      ownershipTransferred: asset.ownershipTransferred || isReadyOrTokenized,
      tokenized: asset.status === "Tokenized",
    };

    const currentStep = !steps.documentApproved ? "document_approval" :
                        !steps.ownerConsent ? "owner_consent" :
                        !steps.spvCreated ? "spv_creation" :
                        !steps.ownershipTransferred ? "ownership_transfer" :
                        !steps.tokenized ? "blockchain_tokenization" : "complete";

    return res.json({
      success: true,
      data: {
        assetId: asset._id,
        assetName: asset.assetName,
        currentStep,
        steps,
        status: asset.status,
        spvDetails: asset.spvDetails,
        tokenizedAt: asset.tokenizedAt,
      },
    });
  } catch (error) {
    console.error("Get tokenization status error:", error);

    return res.status(500).json({
      success: false,
      message: "Error fetching tokenization status",
    });
  }
}

// ==========================================
// 10. PRIVATE: CREATE SPV FOR ASSET
// ==========================================
async function createSPVForAsset(asset, userId) {
  try {
    console.log(`[Asset Controller] Creating SPV for asset ${asset._id}`);

    // Create SPV
    const spvResult = await spvService.createSPV(asset._id, userId);

    if (!spvResult.success) {
      return spvResult;
    }

    // Update asset with SPV details
    const updateResult = await spvService.updateAssetWithSPVDetails(
      asset._id,
      spvResult.spvDetails
    );

    if (!updateResult.success) {
      return updateResult;
    }

    // Send notification
    await notificationService.sendSPVCreationNotification(
      asset.ownerId,
      asset._id,
      spvResult.spvDetails
    );

    // Trigger ownership transfer
    const transferResult = await transferAssetOwnership(asset, spvResult.spvDetails);

    if (!transferResult.success) {
      return transferResult;
    }

    return {
      success: true,
      spvDetails: spvResult.spvDetails,
      blockchainSkipped: transferResult.blockchainSkipped || false,
    };
  } catch (error) {
    console.error("[Asset Controller] Error creating SPV for asset:", error);
    return {
      success: false,
      error: error.message,
    };
  }
}

// ==========================================
// 11. PRIVATE: TRANSFER ASSET OWNERSHIP
// ==========================================
async function transferAssetOwnership(asset, spvDetails) {
  try {
    console.log(`[Asset Controller] Transferring ownership for asset ${asset._id}`);

    // Get company owner ID (placeholder - in production, from config)
    const companyOwnerId = ownershipTransferService.getCompanyOwnerId();

    if (!companyOwnerId) {
      // For now, keep ownership with the asset owner
      // In production, this should transfer to the company
      console.warn("[Asset Controller] Company owner ID not configured, skipping ownership transfer");
    } else {
      // Transfer ownership
      const transferResult = await ownershipTransferService.transferOwnership(
        asset._id,
        companyOwnerId,
        spvDetails
      );

      if (!transferResult.success) {
        return transferResult;
      }

      // Send notification
      await notificationService.sendOwnershipTransferNotification(
        asset.ownerId,
        asset._id,
        asset.assetName || asset.name
      );
    }

    // Mark ownership as transferred even if company owner ID is not configured
    // This allows the workflow to proceed
    if (!companyOwnerId) {
      const mongoose = (await import("mongoose")).default;
      const MongoAsset = mongoose.models.Asset;
      const updatedAsset = await MongoAsset.findById(asset._id);
      if (updatedAsset) {
        updatedAsset.ownershipTransferred = true;
        updatedAsset.ownershipTransferredAt = new Date();
        await updatedAsset.save();
        console.log(`[Asset Controller] Ownership transfer marked as complete (no actual transfer)`);
      }
    }

    // Trigger blockchain tokenization
    const tokenizationResult = await triggerBlockchainTokenization(asset);

    if (!tokenizationResult.success) {
      return tokenizationResult;
    }

    return {
      success: true,
      blockchainSkipped: tokenizationResult.blockchainSkipped || false,
    };
  } catch (error) {
    console.error("[Asset Controller] Error transferring ownership:", error);
    return {
      success: false,
      error: error.message,
    };
  }
}

// ==========================================
// 12. PRIVATE: TRIGGER BLOCKCHAIN TOKENIZATION
// ==========================================
async function triggerBlockchainTokenization(asset) {
  try {
    console.log(`[Asset Controller] Preparing asset data for blockchain: ${asset._id}`);

    // Prepare asset data for blockchain (store in asset for later use)
    asset.blockchainData = {
      name: asset.assetName || asset.name,
      symbol: asset.symbol,
      metadataURI: asset.metadataURI,
      documentHash: asset.documentHash,
      valuationLKR: asset.valuationLKR || asset.valuation,
      totalShares: asset.totalShares,
      issuerWallet: asset.issuerWallet || "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
    };

    // Update asset status to indicate ready for tokenization
    asset.status = "ready_for_tokenization";
    await asset.save();

    console.log(`[Asset Controller] Asset marked as ready for blockchain tokenization`);
    console.log(`[Asset Controller] Asset data prepared for blockchain component`);
    console.log(`\n=== ASSET READY FOR BLOCKCHAIN ===`);
    console.log(`Asset ID: ${asset._id}`);
    console.log(`Asset Name: ${asset.assetName || asset.name}`);
    console.log(`Symbol: ${asset.symbol}`);
    console.log(`Valuation: ${asset.valuationLKR} LKR`);
    console.log(`Total Shares: ${asset.totalShares}`);
    console.log(`Document Hash: ${asset.documentHash}`);
    console.log(`Issuer Wallet: ${asset.blockchainData.issuerWallet}`);
    console.log(`Status: ready_for_tokenization`);
    console.log(`=================================\n`);

    // Send notification indicating readiness
    await notificationService.sendTokenizationCompleteNotification(
      asset.ownerId,
      asset._id,
      asset.assetName || asset.name
    );

    return {
      success: true,
      blockchainSkipped: true,
      message: "Asset data prepared and marked as ready for blockchain tokenization. Blockchain component will handle the actual transactions.",
    };
  } catch (error) {
    console.error("[Asset Controller] Error preparing asset for blockchain:", error);
    return {
      success: false,
      error: error.message,
    };
  }
}

// ==========================================
// 14. BLOCKCHAIN: GET ASSETS
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
// 15. PLATFORM STATISTICS
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
// 16. PRIVATE: DOCUMENT HASH DUPLICATE CHECK
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
// 17. PRIVATE: APPLY AI PIPELINE RESULTS
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
// 18. PRIVATE: ETHEREUM ADDRESS VALIDATION
// ==========================================
function ethersAddressIsValid(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}