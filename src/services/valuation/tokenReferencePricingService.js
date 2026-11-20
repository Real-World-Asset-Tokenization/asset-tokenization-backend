import { readAssetState, lastTrade } from "./blockchainValuationService.js";
import { referencePriceCents, centsToDecimal, percentChange } from "./money.js";

// Dual-price model:
//   reference price = approved valuation / issued supply   (changes only on a published revaluation)
//   market price    = last completed marketplace trade      (changes only when someone trades)
// The two are computed from different sources and never update each other.

export async function getPricing(assetId) {
  const state = await readAssetState(assetId);
  const current = referencePriceCents(state.valuation, state.tokenSupply);
  const latest = state.latestRecord;
  // The previous price uses the supply recorded at that publication (supply does not change, but be exact).
  const previous = latest ? referencePriceCents(latest.previousValuation, latest.tokenSupply) : null;

  let trade = null;
  try { trade = await lastTrade(assetId); } catch { trade = null; }

  return {
    ...state,
    currency: "LKR",
    approvedValuation: state.valuation,
    referencePriceCents: current.toString(),
    referencePrice: centsToDecimal(current),
    previousValuation: latest ? latest.previousValuation : null,
    previousReferencePrice: previous == null ? null : centsToDecimal(previous),
    referencePriceChangePercent: previous == null ? null : percentChange(previous, current),
    lastValuationDate: latest ? latest.effectiveDate : state.registeredAt,
    lastPublishedAt: latest ? latest.publishedAt : null,
    valuationVersion: state.latestVersion,
    lastTrade: trade,
  };
}
