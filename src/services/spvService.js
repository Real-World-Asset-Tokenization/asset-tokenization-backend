import crypto from "crypto";
import SPV from "../models/SPV.js";
import { Asset } from "../models/Asset.js";

/**
 * SPV Service
 * Implements SPV creation with partial implementation including:
 * - Document generation (mock)
 * - Basic validation logic
 * - Document hash generation
 */

class SPVService {
  /**
   * Generate a unique SPV registration number
   */
  generateSPVRegistrationNumber() {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = crypto.randomBytes(3).toString("hex").toUpperCase();
    return `SPV-${timestamp}-${random}`;
  }

  /**
   * Generate SPV document hash for audit trail
   */
  generateSPVDocumentHash(spvData) {
    const dataString = JSON.stringify({
      spvName: spvData.spvName,
      spvRegistrationNumber: spvData.spvRegistrationNumber,
      spvAddress: spvData.spvAddress,
      assetId: spvData.assetId,
      createdAt: new Date().toISOString(),
    });

    return crypto.createHash("sha256").update(dataString).digest("hex");
  }

  /**
   * Validate SPV data
   */
  validateSPVData(spvData) {
    const errors = [];

    if (!spvData.spvName || spvData.spvName.trim().length < 3) {
      errors.push("SPV name must be at least 3 characters");
    }

    if (!spvData.spvAddress || spvData.spvAddress.trim().length < 10) {
      errors.push("SPV address must be at least 10 characters");
    }

    if (!spvData.assetId) {
      errors.push("Asset ID is required");
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Create SPV for an asset
   */
  async createSPV(assetId, createdBy) {
    try {
      // Fetch asset details
      const asset = await Asset.findOne({ _id: assetId });
      if (!asset) {
        throw new Error("Asset not found");
      }

      // Generate SPV data
      const spvRegistrationNumber = this.generateSPVRegistrationNumber();
      const spvName = `${asset.assetName || asset.name} SPV`;
      const spvAddress = `SPV Office, ${asset.location || "Unknown Location"}`;

      const spvData = {
        spvName,
        spvRegistrationNumber,
        spvAddress,
        assetId,
      };

      // Validate SPV data
      const validation = this.validateSPVData(spvData);
      if (!validation.isValid) {
        throw new Error(`SPV validation failed: ${validation.errors.join(", ")}`);
      }

      // Generate document hash
      const spvDocumentHash = this.generateSPVDocumentHash(spvData);

      // Create SPV record
      const spv = await SPV.create({
        assetId,
        spvName,
        spvRegistrationNumber,
        spvAddress,
        spvDocumentHash,
        status: "created",
        createdBy,
      });

      console.log(`[SPV Service] SPV created successfully: ${spvRegistrationNumber}`);
      console.log(`[SPV Service] Document hash: ${spvDocumentHash}`);

      return {
        success: true,
        spv,
        spvDetails: {
          spvName: spv.spvName,
          spvRegistrationNumber: spv.spvRegistrationNumber,
          spvAddress: spv.spvAddress,
          spvDocumentHash: spv.spvDocumentHash,
        },
      };
    } catch (error) {
      console.error("[SPV Service] Error creating SPV:", error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Update asset with SPV details
   */
  async updateAssetWithSPVDetails(assetId, spvDetails) {
    try {
      const mongoose = (await import("mongoose")).default;
      const MongoAsset = mongoose.models.Asset;

      if (!MongoAsset) {
        throw new Error("Asset model not found");
      }

      const asset = await MongoAsset.findById(assetId);

      if (!asset) {
        throw new Error("Asset not found");
      }

      asset.spvCreated = true;
      asset.spvCreatedAt = new Date();
      asset.spvDetails = spvDetails;
      asset.status = "ownership_transfer";

      await asset.save();

      console.log(`[SPV Service] Asset ${assetId} updated with SPV details`);

      return {
        success: true,
        asset,
      };
    } catch (error) {
      console.error("[SPV Service] Error updating asset with SPV details:", error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get SPV by asset ID
   */
  async getSPVByAssetId(assetId) {
    try {
      const spv = await SPV.findOne({ assetId });
      return {
        success: true,
        spv,
      };
    } catch (error) {
      console.error("[SPV Service] Error fetching SPV:", error);
      return {
        success: false,
        error: error.message,
      };
    }
  }
}

export default new SPVService();
