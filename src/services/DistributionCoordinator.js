import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import ownershipIndexer from "./OwnershipIndexer.js";
import profitCalculationService from "./ProfitCalculationService.js";
import merkleDistributionService from "./MerkleDistributionService.js";
import FinancialReport from "../models/FinancialReport.js";
import DistributionRound from "../models/DistributionRound.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class DistributionCoordinator {
  constructor() {
    this.provider = null;
    this.signer = null;
    this.profitDistributionContract = null;
    this.paymentTokenContract = null;
    this.chainId = 31337;
    this.initialize();
  }

  initialize() {
    try {
      const rpcUrl = process.env.BLOCKCHAIN_RPC_URL || "http://127.0.0.1:8545";
      this.provider = new ethers.JsonRpcProvider(rpcUrl);

      const privateKey = process.env.DEPLOYER_PRIVATE_KEY || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
      this.signer = new ethers.Wallet(privateKey, this.provider);

      const contractsPath = path.join(__dirname, "../contracts/deployedContracts.json");
      if (fs.existsSync(contractsPath)) {
        const contractsData = JSON.parse(fs.readFileSync(contractsPath, "utf8"));
        this.chainId = contractsData.chainId || 31337;

        const distConfig = contractsData.contracts?.ProfitDistribution;
        if (distConfig) {
          this.profitDistributionContract = new ethers.Contract(
            distConfig.address,
            distConfig.abi,
            this.signer
          );
          this.distributionContractAddress = distConfig.address;
        }

        const tokenConfig = contractsData.contracts?.MockPaymentToken;
        if (tokenConfig) {
          this.paymentTokenContract = new ethers.Contract(
            tokenConfig.address,
            tokenConfig.abi,
            this.signer
          );
          this.paymentTokenAddress = tokenConfig.address;
        }
      }
    } catch (err) {
      console.warn("⚠ [DistributionCoordinator] Init warning:", err.message);
    }
  }

  /**
   * Complete automated workflow:
   * 1. Index blockchain events
   * 2. Calculate time-weighted profit allocations
   * 3. Construct Merkle tree & proofs
   * 4. Optional on-chain publish & fund
   */
  async prepareAndPublishDistribution({
    assetId,
    periodLabel,
    periodStart,
    periodEnd,
    distributableAmount,
    totalShares,
    reportHash,
    autoPublishOnChain = false
  }) {
    this.initialize();

    console.log(`[DistributionCoordinator] Starting automated distribution for Asset #${assetId} (${periodLabel})...`);

    // Step 1: Sync blockchain ownership events
    await ownershipIndexer.syncEvents(0);

    // Step 2: Compute time-weighted allocations
    const calculation = await profitCalculationService.computeProfitAllocations({
      assetId,
      periodStart,
      periodEnd,
      distributableAmount,
      totalShares,
      decimals: 6
    });

    // Determine roundId
    const existingRounds = await DistributionRound.find();
    const roundId = existingRounds.length + 1;

    // Step 3: Build Merkle Tree and persist allocations and proofs
    const distributionResult = await merkleDistributionService.buildAndPersistDistribution({
      roundId,
      assetId,
      chainId: this.chainId,
      distributionContractAddress: this.distributionContractAddress,
      paymentTokenAddress: this.paymentTokenAddress,
      periodLabel,
      reportHash: reportHash || ethers.keccak256(ethers.toUtf8Bytes(periodLabel)),
      allocations: calculation.allocations,
      totalPayoutBaseUnits: calculation.totalDistributableBaseUnits,
      totalPayoutFormatted: distributableAmount,
      totalEligibleTokenSeconds: calculation.totalEligibleTokenSeconds
    });

    let onChainResult = null;

    // Step 4: Publish on-chain if enabled
    if (autoPublishOnChain && this.profitDistributionContract && this.paymentTokenContract) {
      try {
        console.log(`[DistributionCoordinator] Publishing Round #${roundId} on-chain with root: ${distributionResult.merkleRoot}...`);

        const totalPayoutBig = BigInt(calculation.totalDistributableBaseUnits);

        let currentNonce = await this.provider.getTransactionCount(this.signer.address, "latest");

        // Create round on-chain
        const txCreate = await this.profitDistributionContract.createDistributionRound(
          assetId,
          distributionResult.merkleRoot,
          totalPayoutBig,
          reportHash || ethers.keccak256(ethers.toUtf8Bytes(periodLabel)),
          this.paymentTokenAddress,
          { nonce: currentNonce++ }
        );
        const receiptCreate = await txCreate.wait();

        // Approve and fund round
        const txApprove = await this.paymentTokenContract.approve(
          this.distributionContractAddress,
          totalPayoutBig,
          { nonce: currentNonce++ }
        );
        await txApprove.wait();

        const txFund = await this.profitDistributionContract.fundDistributionRound(
          roundId,
          totalPayoutBig,
          { nonce: currentNonce++ }
        );
        const receiptFund = await txFund.wait();

        // Activate round
        const txActivate = await this.profitDistributionContract.activateDistributionRound(
          roundId,
          { nonce: currentNonce++ }
        );
        const receiptActivate = await txActivate.wait();

        // Update DB round status
        await DistributionRound.updateOne(
          { roundId },
          {
            status: "Active",
            fundedAmount: Number(totalPayoutBig),
            txHashPublish: receiptCreate.hash,
            txHashFunding: receiptFund.hash
          }
        );

        onChainResult = {
          published: true,
          txHashPublish: receiptCreate.hash,
          txHashFunding: receiptFund.hash,
          txHashActivate: receiptActivate.hash
        };

        console.log(`[DistributionCoordinator] Round #${roundId} successfully published, funded, and activated on-chain!`);
      } catch (onChainErr) {
        console.error("⚠ [DistributionCoordinator] On-chain execution failed:", onChainErr.message);
        onChainResult = { published: false, error: onChainErr.message };
      }
    }

    return {
      success: true,
      roundId,
      merkleRoot: distributionResult.merkleRoot,
      eligibleHoldersCount: distributionResult.eligibleHoldersCount,
      calculation,
      onChain: onChainResult
    };
  }
}

const coordinatorInstance = new DistributionCoordinator();
export default coordinatorInstance;
