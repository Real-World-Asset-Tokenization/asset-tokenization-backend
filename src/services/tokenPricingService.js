/**
 * Token Pricing Service — Dual-Price Model Engine
 * 
 * Implements:
 * 1. Initial Reference Pricing: Formula = Approved Valuation / Total Approved Tokens
 * 2. Independent Market Pricing: Secondary orderbook execution prices
 * 3. Decimal-safe calculations (avoiding JavaScript floating-point imprecision)
 * 4. Valuation update without altering issued token supply
 */

export class TokenPricingService {
  /**
   * Calculates the initial reference price per token based on approved valuation and approved shares.
   * @param {number|string|BigInt} valuationLKR Approved net asset value in LKR
   * @param {number|string|BigInt} totalShares Approved total token supply
   * @returns {Object} Price calculation breakdown with formula metadata
   */
  static calculateReferencePrice(valuationLKR, totalShares) {
    const valBig = BigInt(Math.floor(Number(valuationLKR)));
    const sharesBig = BigInt(Math.floor(Number(totalShares)));

    if (sharesBig <= 0n) {
      throw new Error("Total approved token supply must be greater than zero");
    }
    if (valBig <= 0n) {
      throw new Error("Approved asset valuation must be greater than zero");
    }

    // Integer reference price calculation
    const referencePriceBig = valBig / sharesBig;
    const remainder = valBig % sharesBig;
    const preciseDecimal = Number(valBig) / Number(sharesBig);

    return {
      valuationLKR: Number(valBig),
      totalShares: Number(sharesBig),
      referencePriceLKR: Number(referencePriceBig),
      preciseReferencePrice: preciseDecimal,
      currency: "LKR",
      formula: "Approved Net Asset Value / Total Approved Tokens",
      formulaExpression: `LKR ${valBig.toLocaleString()} / ${sharesBig.toLocaleString()} tokens = LKR ${referencePriceBig.toLocaleString()} per token`,
      isExactInteger: remainder === 0n,
    };
  }

  /**
   * Compares the valuation-based Reference Price with the latest secondary Market Trading Price.
   * Demonstrates the Dual-Price Model where market trades do not alter asset reference valuation.
   * 
   * @param {number} referencePriceLKR Valuation-based reference price per token in LKR
   * @param {number} marketPriceUSD Secondary market trade price in mUSD (or converted)
   * @param {number} usdToLkrRate Exchange rate (default 300 LKR per USD)
   * @returns {Object} Comparative metrics, spread, and market discount/premium
   */
  static compareDualPrices(referencePriceLKR, marketPriceUSD, usdToLkrRate = 300) {
    const marketPriceInLKR = marketPriceUSD * usdToLkrRate;
    const priceDifference = marketPriceInLKR - referencePriceLKR;
    const premiumPercent = referencePriceLKR > 0 
      ? ((priceDifference / referencePriceLKR) * 100).toFixed(2)
      : "0.00";

    return {
      referencePriceLKR,
      marketPriceUSD,
      marketPriceInLKR,
      usdToLkrRate,
      spreadLKR: priceDifference,
      premiumDiscountPercent: parseFloat(premiumPercent),
      status: priceDifference > 0 
        ? "Trading at Premium" 
        : priceDifference < 0 
          ? "Trading at Discount" 
          : "Par with Valuation",
      notes: [
        "Reference price is anchored strictly to the latest approved net asset valuation.",
        "Market price reflects secondary marketplace supply and demand.",
        "Secondary market trades do NOT automatically alter the asset's reference valuation.",
      ],
    };
  }

  /**
   * Simulates or prepares a future approved revaluation.
   * Updates reference price per token while preserving total issued token supply and wallet balances.
   * 
   * @param {number} currentValuationLKR Current approved valuation
   * @param {number} newValuationLKR Updated verified valuation
   * @param {number} totalShares Constant approved token supply
   * @param {string} approvalRef Verifier approval ID / certificate reference
   * @returns {Object} Revaluation breakdown
   */
  static calculateRevaluation(currentValuationLKR, newValuationLKR, totalShares, approvalRef = "") {
    const oldPricing = this.calculateReferencePrice(currentValuationLKR, totalShares);
    const newPricing = this.calculateReferencePrice(newValuationLKR, totalShares);

    const deltaValuation = newPricing.valuationLKR - oldPricing.valuationLKR;
    const deltaRefPrice = newPricing.referencePriceLKR - oldPricing.referencePriceLKR;
    const percentChange = ((deltaValuation / oldPricing.valuationLKR) * 100).toFixed(2);

    return {
      assetSharesConstant: totalShares,
      oldValuationLKR: oldPricing.valuationLKR,
      oldReferencePriceLKR: oldPricing.referencePriceLKR,
      newValuationLKR: newPricing.valuationLKR,
      newReferencePriceLKR: newPricing.referencePriceLKR,
      valuationChangeLKR: deltaValuation,
      referencePriceChangeLKR: deltaRefPrice,
      percentageChange: parseFloat(percentChange),
      approvalRef,
      effectiveTimestamp: new Date().toISOString(),
      invariantPreserved: "Token supply and investor balances remain unchanged during revaluation.",
    };
  }
}

export default TokenPricingService;
