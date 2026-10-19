import ownershipCalculator from "./OwnershipCalculator.js";
import { ethers } from "ethers";

class ProfitCalculationService {
  /**
   * Calculates time-weighted profit distributions and baseline snapshot comparison.
   *
   * @param {Object} params
   * @param {number} params.assetId
   * @param {number} params.periodStart - Unix timestamp in seconds
   * @param {number} params.periodEnd - Unix timestamp in seconds
   * @param {number} params.distributableAmount - Distributable profit in nominal units (e.g. 100000)
   * @param {number} params.totalShares - Total asset shares (e.g. 1000)
   * @param {number} [params.decimals=6] - Payment token decimals (default 6 for mUSD)
   */
  async computeProfitAllocations({
    assetId,
    periodStart,
    periodEnd,
    distributableAmount,
    totalShares,
    decimals = 6
  }) {
    if (distributableAmount <= 0) {
      throw new Error("Distributable amount must be strictly greater than 0");
    }

    const holdingData = await ownershipCalculator.calculateHoldingDurations(
      assetId,
      periodStart,
      periodEnd,
      totalShares
    );

    const totalEligibleTokenSeconds = BigInt(holdingData.totalEligibleTokenSeconds);
    const totalDistributableBaseUnits = ethers.parseUnits(distributableAmount.toString(), decimals);

    let sumAllocatedBaseUnits = 0n;
    const allocations = [];

    // 1. Calculate time-weighted payout and baseline snapshot payout for each participant
    for (const participant of holdingData.participants) {
      const tokenSec = BigInt(Math.floor(participant.tokenSeconds));

      // Time-weighted integer calculation
      const payoutBaseUnits = totalEligibleTokenSeconds > 0n
        ? (tokenSec * totalDistributableBaseUnits) / totalEligibleTokenSeconds
        : 0n;

      sumAllocatedBaseUnits += payoutBaseUnits;

      // Baseline comparison: month-end / period-end snapshot balance
      const closingShares = BigInt(participant.closingBalance);
      const snapshotPayoutBaseUnits = totalShares > 0
        ? (closingShares * totalDistributableBaseUnits) / BigInt(totalShares)
        : 0n;

      const payoutFormatted = Number(ethers.formatUnits(payoutBaseUnits, decimals));
      const snapshotFormatted = Number(ethers.formatUnits(snapshotPayoutBaseUnits, decimals));

      allocations.push({
        walletAddress: participant.walletAddress,
        openingBalance: participant.openingBalance,
        closingBalance: participant.closingBalance,
        tokenSeconds: participant.tokenSeconds,
        weightFraction: participant.weightFraction,
        timeWeightedPayoutBaseUnits: payoutBaseUnits.toString(),
        timeWeightedPayoutFormatted: payoutFormatted,
        snapshotPayoutBaseUnits: snapshotPayoutBaseUnits.toString(),
        snapshotPayoutFormatted: snapshotFormatted,
        varianceFormatted: payoutFormatted - snapshotFormatted,
        timeline: participant.timeline
      });
    }

    // 2. Handle residual rounding units deterministically
    const residualBaseUnits = totalDistributableBaseUnits - sumAllocatedBaseUnits;
    if (residualBaseUnits > 0n && allocations.length > 0) {
      // Allocate residual to the participant with the largest tokenSeconds
      allocations.sort((a, b) => b.tokenSeconds - a.tokenSeconds);
      const topHolder = allocations[0];
      const adjusted = BigInt(topHolder.timeWeightedPayoutBaseUnits) + residualBaseUnits;
      topHolder.timeWeightedPayoutBaseUnits = adjusted.toString();
      topHolder.timeWeightedPayoutFormatted = Number(ethers.formatUnits(adjusted, decimals));
      topHolder.residualAdjustment = Number(ethers.formatUnits(residualBaseUnits, decimals));
    }

    // Sort by wallet address deterministically
    allocations.sort((a, b) => a.walletAddress.localeCompare(b.walletAddress));

    return {
      assetId,
      periodStart,
      periodEnd,
      periodDuration: holdingData.periodDuration,
      totalShares,
      totalEligibleTokenSeconds: holdingData.totalEligibleTokenSeconds,
      distributableAmount,
      totalDistributableBaseUnits: totalDistributableBaseUnits.toString(),
      residualBaseUnits: residualBaseUnits.toString(),
      allocations
    };
  }
}

const profitServiceInstance = new ProfitCalculationService();
export default profitServiceInstance;
