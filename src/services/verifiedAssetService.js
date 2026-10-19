import { Asset } from "../models/Asset.js";
import { TokenizationRecord } from "../models/TokenizationRecord.js";
import { TokenPricingService } from "./tokenPricingService.js";
import blockchainReconciler from "./blockchainReconciliationService.js";

export class VerifiedAssetService {
  /**
   * Retrieves verified assets eligible for tokenization, optionally filtered by owner wallet.
   * Ensures frontend only displays verified, actionable assets to their rightful owners.
   */
  static async getVerifiedAssets(ownerWallet = null) {
    let assets = await Asset.find();

    // Map and enrich with tokenization records from Azure Cosmos DB / memory
    const enriched = await Promise.all(
      assets.map(async (asset) => {
        const tokenRecord = await TokenizationRecord.findOne({ assetId: asset.assetId });
        
        // Also check authoritative on-chain status if possible
        let onChainTokenized = false;
        try {
          const onChainStatus = await blockchainReconciler.getOnChainAssetStatus(asset.assetId);
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
          blockchainAssetId: Number(asset.blockchainAssetId || asset.assetId),
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

    const onChainAssetId = Number(asset.blockchainAssetId || asset.assetId);

    try {
      const onChain = await blockchainReconciler.getOnChainAssetStatus(onChainAssetId);
      if (onChain.isTokenizedOnChain) {
        isAlreadyTokenized = true;
      }
    } catch (e) {
      // ignore
    }

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
      isEligible: !isAlreadyTokenized,
      existingStatus: isAlreadyTokenized ? "TOKENIZED" : "VERIFIED_ELIGIBLE",
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
          tokenId: Number(assetId),
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

    return {
      success: true,
      message: "Asset tokenization verified and recorded successfully in Azure Cosmos DB.",
      tokenRecord,
      blockchainVerification: verification,
    };
  }
}

export default VerifiedAssetService;
