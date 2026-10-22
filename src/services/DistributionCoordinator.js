import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import ownershipIndexer from "./OwnershipIndexer.js";
import profitCalculationService from "./ProfitCalculationService.js";
import merkleDistributionService from "./MerkleDistributionService.js";
import gasAnalyticsService from "./GasAnalyticsService.js";
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

        const registryConfig = contractsData.contracts?.AssetRegistry;
        if (registryConfig) {
          this.registryContract = new ethers.Contract(registryConfig.address, registryConfig.abi, this.signer);
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
   * Complete workflow:
   * 1. Read the asset from the chain (it must be tokenized; total supply comes from the chain)
   * 2. Index ownership events and calculate time-weighted allocations
   * 3. Build the Merkle tree for the next on-chain round id
   * 4. If publishing: create, fund and activate on-chain, then save. A preview saves nothing.
   */
  async prepareAndPublishDistribution({
    assetId,
    periodLabel,
    periodStart,
    periodEnd,
    distributableAmount,
    reportId,
    reportHash,
    autoPublishOnChain = false
  }) {
    this.initialize();
    if (!this.profitDistributionContract || !this.paymentTokenContract || !this.registryContract) {
      throw new Error("Distribution contracts are not configured. Redeploy contracts and copy deployedContracts.json.");
    }

    // An approved financial report is the source of the amount and period.
    let report = null;
    if (reportId) {
      report = await FinancialReport.findOne({ reportId });
      if (!report) throw new Error("Financial report not found");
      if (report.status !== "Approved") throw new Error("The financial report must be approved first");
      if (report.distributionRoundId) throw new Error(`This report was already paid in round #${report.distributionRoundId}`);
      if (!(report.distributableAmount > 0)) throw new Error("This report has no distributable profit (net profit is zero or covers a carried-forward loss)");
      assetId = report.assetId;
      periodLabel = report.periodLabel;
      periodStart = report.startTimestamp;
      periodEnd = report.endTimestamp;
      distributableAmount = report.distributableAmount;
      reportHash = report.reportHash;
    }

    if (!(periodEnd > periodStart)) throw new Error("Period end must be after period start");
    // Future holdings are unknown, so the period must already be over.
    const latest = await this.provider.getBlock("latest");
    if (periodEnd > Math.max(latest.timestamp, Math.floor(Date.now() / 1000))) {
      throw new Error("The period has not ended yet. Choose an end date in the past.");
    }

    const asset = await this.registryContract.getAsset(assetId);
    if (Number(asset.status) !== 2) throw new Error(`Asset #${assetId} is not tokenized on-chain`);
    const totalShares = Number(asset.totalShares);

    console.log(`[DistributionCoordinator] Preparing distribution for Asset #${assetId} (${periodLabel})...`);

    await ownershipIndexer.syncEvents(0);

    const calculation = await profitCalculationService.computeProfitAllocations({
      assetId, periodStart, periodEnd, distributableAmount, totalShares, decimals: 6
    });

    // Leaves include the round id, so it must be the id the contract will assign.
    const roundId = Number(await this.profitDistributionContract.nextRoundId());
    const finalReportHash = reportHash || ethers.keccak256(ethers.toUtf8Bytes(`${assetId}:${periodLabel}:${periodStart}:${periodEnd}`));

    const built = merkleDistributionService.buildDistribution({
      roundId,
      assetId,
      chainId: this.chainId,
      distributionContractAddress: this.distributionContractAddress,
      paymentTokenAddress: this.paymentTokenAddress,
      periodLabel,
      reportHash: finalReportHash,
      allocations: calculation.allocations,
      totalPayoutBaseUnits: calculation.totalDistributableBaseUnits,
      totalPayoutFormatted: distributableAmount,
      totalEligibleTokenSeconds: calculation.totalEligibleTokenSeconds
    });

    const summary = {
      roundId,
      assetId,
      assetName: asset.name,
      periodLabel,
      merkleRoot: built.merkleRoot,
      eligibleHoldersCount: built.eligibleHoldersCount,
      calculation
    };
    if (!autoPublishOnChain) return { success: true, preview: true, ...summary };

    const totalPayoutBig = BigInt(calculation.totalDistributableBaseUnits);
    const balance = await this.paymentTokenContract.balanceOf(this.signer.address);
    if (balance < totalPayoutBig) {
      throw new Error(`Platform wallet holds ${ethers.formatUnits(balance, 6)} mUSD but this round needs ${distributableAmount} mUSD`);
    }

    let nonce = await this.provider.getTransactionCount(this.signer.address, "latest");
    const receiptCreate = await (await this.profitDistributionContract.createDistributionRound(
      assetId, built.merkleRoot, totalPayoutBig, finalReportHash, this.paymentTokenAddress, { nonce: nonce++ }
    )).wait();

    // The round now exists on-chain, so save it before funding.
    await gasAnalyticsService.recordPlatformReceipt(receiptCreate, "DistributionPublish", { assetId, roundId });
    await merkleDistributionService.persistDistribution(built, { txHashPublish: receiptCreate.hash });
    if (report) await FinancialReport.updateOne({ reportId: report.reportId }, { distributionRoundId: roundId });

    try {
      const receiptApprove = await (await this.paymentTokenContract.approve(this.distributionContractAddress, totalPayoutBig, { nonce: nonce++ })).wait();
      const receiptFund = await (await this.profitDistributionContract.fundDistributionRound(roundId, totalPayoutBig, { nonce: nonce++ })).wait();
      const receiptActivate = await (await this.profitDistributionContract.activateDistributionRound(roundId, { nonce: nonce++ })).wait();

      await gasAnalyticsService.recordPlatformReceipt(receiptApprove, "AdminOperation", { assetId, roundId });
      await gasAnalyticsService.recordPlatformReceipt(receiptFund, "DistributionFunding", { assetId, roundId });
      await gasAnalyticsService.recordPlatformReceipt(receiptActivate, "AdminOperation", { assetId, roundId });

      await DistributionRound.updateOne(
        { roundId },
        { status: "Active", fundedAmount: Number(totalPayoutBig), txHashFunding: receiptFund.hash }
      );
      console.log(`[DistributionCoordinator] Round #${roundId} published, funded and activated.`);
      return {
        success: true,
        ...summary,
        onChain: { published: true, txHashPublish: receiptCreate.hash, txHashFunding: receiptFund.hash, txHashActivate: receiptActivate.hash }
      };
    } catch (err) {
      throw new Error(`Round #${roundId} was created on-chain but funding/activation failed: ${err.shortMessage || err.message}`);
    }
  }
}

const coordinatorInstance = new DistributionCoordinator();
export default coordinatorInstance;
