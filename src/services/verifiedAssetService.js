import { Asset } from "../models/Asset.js";
import { TokenizationRecord } from "../models/TokenizationRecord.js";
import { TokenPricingService } from "./tokenPricingService.js";
import blockchainReconciler from "./blockchainReconciliationService.js";
import { invalidateChainSync } from "./chainSyncService.js";

export class VerifiedAssetService {
  static async resolveRegisteredAsset(asset) {
    const registry = blockchainReconciler.getAssetRegistryContract();
    const owner = (asset.issuerWallet || asset.ownerAddress || "").toLowerCase();
    // A database ID is not proof of a registry identity. Match immutable deed
    // metadata and the issuer, including after a local-chain reset.
    if (!owner || !asset.documentHash) return null;
    const ids = await registry.getAssetsByIssuer(owner);
    const matches = [];
    for (const id of ids) {
      const record = await registry.getAsset(id);
      if (record.documentHash === asset.documentHash &&
          record.issuer.toLowerCase() === owner &&
          Number(record.totalShares) === Number(asset.totalShares)) {
        matches.push(record);
      }
    }
    if (matches.length > 1) {
      throw new Error("Multiple registry assets match this deed. Reconcile the registration before tokenizing.");
    }
    if (!matches.length) return null;
    const record = matches[0];
    await Asset.findOneAndUpdate(
      { assetId: Number(asset.assetId) },
      { $set: { blockchainAssetId: Number(record.assetId) } }
    );
    return record;
  }
  /**
   * Retrieves verified assets eligible for tokenization, optionally filtered by owner wallet.
   * Ensures frontend only displays verified, actionable assets to their rightful owners.
   */
  static async getVerifiedAssets(ownerWallet = null, ownerId = null) {
    let assets = await Asset.find(ownerId ? { ownerId } : {});
    if (ownerWallet) {
      assets = assets.filter(asset =>
        (asset.issuerWallet || asset.ownerAddress || "").toLowerCase() === ownerWallet.toLowerCase()
      );
    }

    // Map and enrich with tokenization records from Azure Cosmos DB / memory
    const enriched = await Promise.all(
      assets.map(async (asset) => {
        const tokenRecord = await TokenizationRecord.findOne({ assetId: asset.assetId });
        
        // Also check authoritative on-chain status if possible
        let onChainTokenized = false;
        try {
          const onChainStatus = await blockchainReconciler.getOnChainAssetStatus(asset.blockchainAssetId ?? tokenRecord?.tokenId ?? asset.assetId);
          onChainTokenized = onChainStatus.isTokenizedOnChain;
        } catch (e) {
          // If contract doesn't have asset yet, fallback to db status
        }

        const isVerified =
          asset.status === "Approved" ||
          asset.verificationStatus === "APPROVED" ||
          asset.status === "Tokenized";

        const isTokenized =
          onChainTokenized ||
          asset.status === "Tokenized" ||
          (tokenRecord && tokenRecord.tokenizationStatus === "TOKENIZED");

        let pricing = null;
        try {
          pricing = TokenPricingService.calculateReferencePrice(
            asset.valuationLKR || asset.valuation || 10000000,
            asset.totalShares || 1000
          );
        } catch (e) {
          pricing = { referencePriceLKR: 0 };
        }

        return {
          assetId: asset.assetId,
          ownerId: asset.ownerId || null,
          blockchainAssetId: Number(asset.blockchainAssetId ?? tokenRecord?.tokenId ?? asset.assetId),
          name: asset.name || asset.assetName,
          symbol: asset.symbol,
          propertyType: asset.propertyType || "Residential Real Estate",
          location: asset.location,
          ownerWallet: asset.issuerWallet || asset.ownerAddress,
          valuationLKR: asset.valuationLKR || asset.valuation,
          totalShares: asset.totalShares,
          referencePriceLKR: pricing.referencePriceLKR,
          verificationStatus: isVerified ? "APPROVED" : "PENDING",
          tokenizationStatus: isTokenized ? "TOKENIZED" : "VERIFIED_ELIGIBLE",
          isEligibleForTokenization: isVerified && !isTokenized,
          documentHash: asset.documentHash,
          metadataURI: asset.metadataURI,
          imageUrl: asset.imageUrl,
          createdAt: asset.createdAt,
        };
      })
    );

    if (ownerWallet) {
      return enriched.filter(
        (a) => a.ownerWallet && a.ownerWallet.toLowerCase() === ownerWallet.toLowerCase()
      );
    }

    return enriched;
  }

  /**
   * Prepares the unmodifiable tokenization preview for an owner prior to MetaMask signing.
   */
  static async getTokenizationPreview(assetId, callerWallet = null) {
    const asset = await Asset.findOne({ assetId: Number(assetId) });
    if (!asset) {
      throw new Error(`Asset #${assetId} not found`);
    }

    // Owner authorization validation
    if (callerWallet) {
      const owner = (asset.issuerWallet || asset.ownerAddress || "").toLowerCase();
      if (owner && owner !== callerWallet.toLowerCase()) {
        throw new Error("Unauthorized: Only the verified asset owner can preview or initiate tokenization");
      }
    }

    // Check if already tokenized
    let isAlreadyTokenized = asset.status === "Tokenized";
    const existingRecord = await TokenizationRecord.findOne({ assetId: Number(assetId) });
    if (existingRecord && existingRecord.tokenizationStatus === "TOKENIZED") {
      isAlreadyTokenized = true;
    }

    const registeredAsset = await this.resolveRegisteredAsset(asset);
    const onChainAssetId = registeredAsset ? Number(registeredAsset.assetId) : null;
    isAlreadyTokenized = registeredAsset ? Number(registeredAsset.status) === 2 : false;
    const isApproved = registeredAsset && Number(registeredAsset.status) === 1;
    const blockingReason = !registeredAsset
      ? "This asset is not registered on the current blockchain. Register it again and obtain on-chain approval before tokenizing."
      : isAlreadyTokenized ? "Asset already tokenized."
      : !isApproved ? "This asset requires approval in the on-chain registry before tokenizing."
      : null;

    const valuation = asset.valuationLKR || asset.valuation || 10000000;
    const totalShares = asset.totalShares || 1000;
    const pricing = TokenPricingService.calculateReferencePrice(valuation, totalShares);

    return {
      assetId: Number(asset.assetId),
      blockchainAssetId: onChainAssetId,
      assetName: asset.name || asset.assetName,
      assetSymbol: asset.symbol,
      propertyType: asset.propertyType || "Residential Real Estate",
      location: asset.location,
      ownerWallet: asset.issuerWallet || asset.ownerAddress,
      approvedValuation: pricing.valuationLKR,
      valuationCurrency: pricing.currency,
      approvedTokenSupply: pricing.totalShares,
      calculatedReferencePrice: pricing.referencePriceLKR,
      formulaExplanation: pricing.formulaExpression,
      isEligible: Boolean(isApproved),
      blockingReason,
      existingStatus: isAlreadyTokenized ? "TOKENIZED" : isApproved ? "VERIFIED_ELIGIBLE" : "REGISTRATION_REQUIRED",
      documentHash: asset.documentHash,
      metadataURI: asset.metadataURI,
      estimatedGasUnits: 251218, // Measured from Hardhat benchmark test
    };
  }

  /**
   * Confirms a completed on-chain tokenization, reconciles the transaction receipt,
   * and updates Azure Cosmos DB records atomically.
   */
  static async confirmTokenization({ assetId, txHash, ownerWallet }) {
    if (!txHash) {
      throw new Error("Transaction hash is required for blockchain reconciliation");
    }

    const asset = await Asset.findOne({ assetId: Number(assetId) });
    if (!asset) {
      throw new Error(`Asset #${assetId} does not exist`);
    }

    const expectedRecipient = ownerWallet || asset.issuerWallet || asset.ownerAddress;
    const expectedShares = asset.totalShares || 1000;
    const onChainAssetId = Number(asset.blockchainAssetId || asset.assetId);

    // 1. Authoritative verification of transaction receipt and logs on blockchain
    const verification = await blockchainReconciler.verifyTokenizationReceipt(
      txHash,
      onChainAssetId,
      expectedRecipient
    );

    // 2. Compute reference price
    const valuation = asset.valuationLKR || asset.valuation || 10000000;
    const pricing = TokenPricingService.calculateReferencePrice(valuation, expectedShares);

    // 3. Atomically update or create TokenizationRecord in Azure Cosmos DB / memory
    const tokenRecord = await TokenizationRecord.findOneAndUpdate(
      { assetId: Number(assetId) },
      {
        $set: {
          assetId: Number(assetId),
          assetName: asset.name || asset.assetName,
          assetSymbol: asset.symbol,
          ownerWallet: expectedRecipient,
          approvedValuation: pricing.valuationLKR,
          valuationCurrency: pricing.currency,
          approvedTokenSupply: expectedShares,
          calculatedReferencePrice: pricing.referencePriceLKR,
          tokenizationStatus: "TOKENIZED",
          chainId: 31337,
          contractAddress: verification.contractAddress,
          tokenId: onChainAssetId,
          mintingTxHash: txHash,
          confirmedBlockNumber: verification.blockNumber,
          approvedMetadataHash: asset.documentHash,
          gasUsed: verification.gasUsed,
          effectiveGasPrice: verification.effectiveGasPrice,
        },
      },
      { new: true, upsert: true }
    );

    // 4. Update Asset status to Tokenized
    await Asset.findOneAndUpdate(
      { assetId: Number(assetId) },
      {
        $set: {
          status: "Tokenized",
          txHash: txHash,
          tokenizedAt: new Date(),
        },
      }
    );

    invalidateChainSync();
    return {
      success: true,
      message: "Asset tokenization verified and recorded successfully in Azure Cosmos DB.",
      tokenRecord,
      blockchainVerification: verification,
    };
  }
}

export default VerifiedAssetService;
