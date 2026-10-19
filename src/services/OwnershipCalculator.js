import OwnershipEvent from "../models/OwnershipEvent.js";
import { ethers } from "ethers";

class OwnershipCalculator {
  /**
   * Reconstructs historical ownership intervals and calculates token-holding seconds.
   *
   * @param {number} assetId
   * @param {number} periodStart - Unix timestamp in seconds
   * @param {number} periodEnd - Unix timestamp in seconds
   * @param {number} totalShares - Total asset fraction supply (e.g. 1000)
   */
  async calculateHoldingDurations(assetId, periodStart, periodEnd, totalShares) {
    if (periodEnd <= periodStart) {
      throw new Error("periodEnd must be strictly greater than periodStart");
    }

    const periodDuration = periodEnd - periodStart;
    const totalEligibleTokenSeconds = totalShares * periodDuration;

    // Retrieve all events for this asset up to periodEnd
    const allEvents = await OwnershipEvent.find({
      assetId: Number(assetId),
      blockTimestamp: { $lte: periodEnd }
    });

    const zeroAddress = ethers.ZeroAddress.toLowerCase();

    // 1. Calculate opening balances at periodStart
    const openingBalances = {};
    const periodEvents = [];

    for (const evt of allEvents) {
      if (evt.blockTimestamp < periodStart) {
        if (evt.fromAddress !== zeroAddress) {
          openingBalances[evt.fromAddress] = (openingBalances[evt.fromAddress] || 0) - evt.amount;
        }
        if (evt.toAddress !== zeroAddress) {
          openingBalances[evt.toAddress] = (openingBalances[evt.toAddress] || 0) + evt.amount;
        }
      } else {
        periodEvents.push(evt);
      }
    }

    // Collect all unique participant addresses
    const participants = new Set();
    for (const addr of Object.keys(openingBalances)) {
      if (openingBalances[addr] > 0) participants.add(addr);
    }
    for (const evt of periodEvents) {
      if (evt.fromAddress !== zeroAddress) participants.add(evt.fromAddress);
      if (evt.toAddress !== zeroAddress) participants.add(evt.toAddress);
    }

    // 2. Build time-weighted holding timelines per participant
    const results = [];

    for (const wallet of participants) {
      const initialBal = Math.max(0, openingBalances[wallet] || 0);
      let currentBal = initialBal;
      let lastTimestamp = periodStart;
      let tokenSeconds = 0;
      const timeline = [];

      // Filter and sort events affecting this wallet within the period
      const walletEvents = periodEvents
        .filter((e) => e.fromAddress === wallet || e.toAddress === wallet)
        .sort((a, b) => a.blockTimestamp - b.blockTimestamp || a.logIndex - b.logIndex);

      for (const evt of walletEvents) {
        const eventTime = Math.min(Math.max(evt.blockTimestamp, periodStart), periodEnd);
        const duration = eventTime - lastTimestamp;

        if (duration > 0 && currentBal > 0) {
          const deltaTokenSeconds = currentBal * duration;
          tokenSeconds += deltaTokenSeconds;
          timeline.push({
            start: lastTimestamp,
            end: eventTime,
            balance: currentBal,
            duration,
            tokenSeconds: deltaTokenSeconds
          });
        }

        // Apply transfer delta
        if (evt.fromAddress === wallet) {
          currentBal -= evt.amount;
        }
        if (evt.toAddress === wallet) {
          currentBal += evt.amount;
        }

        lastTimestamp = eventTime;
      }

      // Final interval up to periodEnd
      const finalDuration = periodEnd - lastTimestamp;
      if (finalDuration > 0 && currentBal > 0) {
        const deltaTokenSeconds = currentBal * finalDuration;
        tokenSeconds += deltaTokenSeconds;
        timeline.push({
          start: lastTimestamp,
          end: periodEnd,
          balance: currentBal,
          duration: finalDuration,
          tokenSeconds: deltaTokenSeconds
        });
      }

      const weightFraction = totalEligibleTokenSeconds > 0
        ? tokenSeconds / totalEligibleTokenSeconds
        : 0;

      results.push({
        walletAddress: wallet.toLowerCase(),
        openingBalance: initialBal,
        closingBalance: Math.max(0, currentBal),
        tokenSeconds,
        weightFraction,
        timeline
      });
    }

    return {
      assetId,
      periodStart,
      periodEnd,
      periodDuration,
      totalShares,
      totalEligibleTokenSeconds,
      participants: results
    };
  }
}

const calculatorInstance = new OwnershipCalculator();
export default calculatorInstance;
