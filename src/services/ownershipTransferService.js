import crypto from "crypto";
import { Asset } from "../models/Asset.js";
import User from "../models/User.js";

/**
 * Ownership Transfer Service
 * Implements ownership transfer with partial implementation including:
 * - Document generation (mock)
 * - Basic validation logic
 * - Document hash generation
 */

class OwnershipTransferService {
  /**
   * Generate ownership transfer document hash
   */
  generateTransferDocumentHash(transferData) {
    const dataString = JSON.stringify({
      assetId: transferData.assetId,
      fromOwnerId: transferData.fromOwnerId,
      toOwnerId: transferData.toOwnerId,
      spvDetails: transferData.spvDetails,
      transferDate: new Date().toISOString(),
    });

    return crypto.createHash("sha256").update(dataString).digest("hex");
  }

  /**
   * Validate ownership transfer data
   */
  validateTransferData(transferData) {
    const errors = [];

    if (!transferData.assetId) {
      errors.push("Asset ID is required");
    }

    if (!transferData.fromOwnerId) {
      errors.push("Current owner ID is required");
    }

    if (!transferData.toOwnerId) {
      errors.push("New owner ID is required");
    }

    if (transferData.fromOwnerId === transferData.toOwnerId) {
      errors.push("From and to owner IDs cannot be the same");
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Generate mock transfer document (as a string representation)
   */
  generateTransferDocument(transferData) {
    const document = `
OWNERSHIP TRANSFER AGREEMENT
==============================

Date: ${new Date().toLocaleDateString()}
Transfer ID: ${crypto.randomBytes(8).toString("hex").toUpperCase()}

PARTIES
-------
Transfer From: ${transferData.fromOwnerName} (ID: ${transferData.fromOwnerId})
Transfer To: ${transferData.toOwnerName} (ID: ${transferData.toOwnerId})

ASSET DETAILS
-------------
Asset ID: ${transferData.assetId}
Asset Name: ${transferData.assetName}
Asset Location: ${transferData.assetLocation}
Valuation: ${transferData.valuation} ${transferData.currency}

SPV DETAILS
-----------
SPV Name: ${transferData.spvDetails.spvName}
SPV Registration Number: ${transferData.spvDetails.spvRegistrationNumber}
SPV Address: ${transferData.spvDetails.spvAddress}

TERMS
-----
1. The current owner transfers full ownership of the asset to the SPV.
2. The SPV is a legal entity created specifically for this asset.
3. All rights, title, and interest in the asset are transferred.
4. The transfer is effective immediately upon signing.

DOCUMENT HASH: ${this.generateTransferDocumentHash(transferData)}

This document is automatically generated for record-keeping purposes.
For legal purposes, a formal transfer deed should be executed.
`;

    return document;
  }

  /**
   * Transfer ownership of an asset
   */
  async transferOwnership(assetId, toOwnerId, spvDetails) {
    try {
      // Fetch asset details
      const mongoose = (await import("mongoose")).default;
      const MongoAsset = mongoose.models.Asset;

      if (!MongoAsset) {
        throw new Error("Asset model not found");
      }

      const asset = await MongoAsset.findById(assetId);

      if (!asset) {
        throw new Error("Asset not found");
      }

      const fromOwnerId = asset.ownerId;

      // Fetch owner details
      const fromOwner = await User.findById(fromOwnerId);
      const toOwner = await User.findById(toOwnerId);

      if (!fromOwner) {
        throw new Error("Current owner not found");
      }

      if (!toOwner) {
        throw new Error("New owner not found");
      }

      // Prepare transfer data
      const transferData = {
        assetId,
        fromOwnerId,
        toOwnerId,
        fromOwnerName: fromOwner.name,
        toOwnerName: toOwner.name,
        assetName: asset.assetName || asset.name,
        assetLocation: asset.location,
        valuation: asset.valuationLKR || asset.valuation,
        currency: asset.currency,
        spvDetails,
      };

      // Validate transfer data
      const validation = this.validateTransferData(transferData);
      if (!validation.isValid) {
        throw new Error(`Transfer validation failed: ${validation.errors.join(", ")}`);
      }

      // Generate transfer document
      const transferDocument = this.generateTransferDocument(transferData);
      const transferDocumentHash = this.generateTransferDocumentHash(transferData);

      // Update asset ownership
      asset.ownerId = toOwnerId;
      asset.ownershipTransferred = true;
      asset.ownershipTransferredAt = new Date();
      asset.ownershipTransferDocument = transferDocumentHash;
      asset.status = "ready_for_tokenization";

      await asset.save();

      console.log(`[Ownership Transfer Service] Ownership transferred successfully`);
      console.log(`[Ownership Transfer Service] From: ${fromOwner.name} (${fromOwnerId})`);
      console.log(`[Ownership Transfer Service] To: ${toOwner.name} (${toOwnerId})`);
      console.log(`[Ownership Transfer Service] Document hash: ${transferDocumentHash}`);

      return {
        success: true,
        asset,
        transferDocument,
        transferDocumentHash,
      };
    } catch (error) {
      console.error("[Ownership Transfer Service] Error transferring ownership:", error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get company owner ID (placeholder - in production, this would be from config)
   */
  getCompanyOwnerId() {
    // In production, this should come from environment variables or config
    // For now, we'll return a placeholder
    return process.env.COMPANY_OWNER_ID || null;
  }
}

export default new OwnershipTransferService();
