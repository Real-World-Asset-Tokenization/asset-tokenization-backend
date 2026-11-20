import { ethers } from "ethers";
import { loadDeployment } from "./chainContracts.js";

export const STAGES = ["Tokenization", "Listing", "Purchase", "Resale", "Voting", "Escrow", "Payout", "Other"];
export const PAYER_CATEGORIES = ["Platform", "AssetOwner", "Investor", "Relayer"];

// Set-up and faucet calls are not part of the business flow, so they are not counted.
const SKIP_METHODS = new Set([
  "mint", "setAuthorizedCaller", "setAssetTokenContract", "setAuthorizedVerifier", "setFeeBps",
  "setTreasury", "setRoyaltyBps", "transferOwnership", "renounceOwnership", "setAssetToken", "setAssetRegistry",
]);

// Methods only the platform (the contract owner) can call.
const OWNER_ONLY = new Set([
  "approveAsset", "rejectAsset", "openVoting", "confirmSale", "cancelOffer", "createDistributionRound",
  "activateDistributionRound", "closeDistributionRound", "updateAssetValuation",
]);

// Methods a buyer calls: even an asset owner is an investor when buying another owner's tokens.
const BUYER_METHODS = new Set(["buyListing", "buyListingAmount", "fillSignedOrder", "fillSignedOrderWithPermit", "fillFollowOrder", "fillFollowOrderWithPermit"]);

const METHOD_STAGE = {
  registerAsset: "Tokenization", approveAsset: "Tokenization", rejectAsset: "Tokenization",
  tokenize: "Tokenization", tokenizeAsset: "Tokenization", tokenizeAssetByOwner: "Tokenization",
  createListing: "Listing", cancelListing: "Listing", cancelSignedOrder: "Listing", cancelFollowOrder: "Listing",
  buyListing: "Purchase", buyListingAmount: "Purchase", fillSignedOrder: "Purchase", fillSignedOrderWithPermit: "Purchase", fillFollowOrder: "Purchase", fillFollowOrderWithPermit: "Purchase",
  castVote: "Voting", castVotesBySig: "Voting", openVoting: "Voting", finalize: "Voting",
  createProposal: "Voting", finalizeProposal: "Voting",
  createOffer: "Escrow", withdrawOffer: "Escrow", cancelOffer: "Escrow", confirmSale: "Escrow",
  claim: "Payout", claimProfit: "Payout", createDistributionRound: "Payout",
  fundDistributionRound: "Payout", activateDistributionRound: "Payout", closeDistributionRound: "Payout",
};

// Kept so the existing operation breakdown and older records stay meaningful.
const METHOD_OPERATION = {
  registerAsset: "AssetTokenization", approveAsset: "AssetTokenization", tokenize: "AssetTokenization",
  tokenizeAsset: "AssetTokenization", tokenizeAssetByOwner: "AssetTokenization",
  createListing: "MarketplaceListing", buyListing: "MarketplacePurchase", buyListingAmount: "MarketplacePurchase",
  fillSignedOrder: "SignedOrderPurchase", fillSignedOrderWithPermit: "SignedOrderPurchase",
  fillFollowOrder: "SignedOrderPurchase", fillFollowOrderWithPermit: "SignedOrderPurchase",
  createOffer: "SaleOffer", castVote: "SaleVote", castVotesBySig: "SaleVoteRelay",
  openVoting: "SaleAdmin", finalize: "SaleAdmin", confirmSale: "SaleAdmin", cancelOffer: "SaleAdmin",
  claim: "SaleClaim", claimProfit: "ProfitClaim", createDistributionRound: "DistributionPublish",
  fundDistributionRound: "DistributionFunding",
};

const sameAddress = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();

/** Everything needed to decode and classify transactions against the current deployment. */
export async function buildContext() {
  const { data, provider, deployment } = loadDeployment();
  const contracts = new Map(); // address -> { name, iface }
  for (const [name, config] of Object.entries(data.contracts || {})) {
    contracts.set(config.address.toLowerCase(), { name, iface: new ethers.Interface(config.abi), address: config.address, contract: new ethers.Contract(config.address, config.abi, provider) });
  }

  const registryConfig = data.contracts.AssetRegistry;
  const registry = new ethers.Contract(registryConfig.address, registryConfig.abi, provider);
  const platform = new Set();
  if (process.env.DEPLOYER_PRIVATE_KEY) platform.add(new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY).address.toLowerCase());
  else platform.add("0xf39fd6e51aad88f6f4ce6aab8827279cfffb92266"); // dev default signer used by the backend services
  try { platform.add((await registry.owner()).toLowerCase()); } catch { /* registry without owner() */ }
  const saleConfig = data.contracts.PropertySale;
  if (saleConfig) {
    try { platform.add((await new ethers.Contract(saleConfig.address, saleConfig.abi, provider).owner()).toLowerCase()); } catch { /* ignore */ }
  }

  const issuers = new Map(); // assetId -> issuer
  try {
    const next = Number(await registry.nextAssetId());
    for (let id = 1; id < next; id++) issuers.set(id, (await registry.getAsset(id)).issuer.toLowerCase());
  } catch { /* registry without assets */ }

  return { data, provider, deployment, contracts, platform, issuers, allIssuers: new Set(issuers.values()), addresses: new Map(Object.entries(data.contracts).map(([n, c]) => [n, c.address.toLowerCase()])) };
}

function spenderStage(spender, ctx) {
  const s = String(spender || "").toLowerCase();
  if (s === ctx.addresses.get("TokenMarketplace")) return "Purchase";
  if (s === ctx.addresses.get("PropertySale")) return "Escrow";
  if (s === ctx.addresses.get("ProfitDistribution")) return "Payout";
  return null;
}

/**
 * Decodes one mined transaction sent to a deployed contract and says what it was:
 * which contract method, which business stage, and who paid (Platform, AssetOwner, Investor or Relayer).
 * Returns null for transactions that are not part of the business flow.
 */
export async function classify(tx, receipt, ctx) {
  const entry = ctx.contracts.get(String(tx.to || "").toLowerCase());
  if (!entry) return null;

  let parsed;
  try { parsed = entry.iface.parseTransaction({ data: tx.data, value: tx.value }); } catch { return null; }
  if (!parsed || SKIP_METHODS.has(parsed.name)) return null;
  const method = parsed.name;

  const events = [];
  for (const log of receipt.logs) {
    const e = ctx.contracts.get(log.address.toLowerCase());
    if (!e) continue;
    try { const p = e.iface.parseLog(log); if (p) events.push(p); } catch { /* not decodable */ }
  }
  const assetEvent = events.find((p) => p.args?.assetId !== undefined);
  let assetId = assetEvent ? Number(assetEvent.args.assetId) : null;
  if (assetId == null && parsed.args?.assetId !== undefined) assetId = Number(parsed.args.assetId);
  // Sale and dividend calls name an offer or round; look up the property it belongs to.
  try {
    if (assetId == null && entry.name === "PropertySale" && parsed.args?.offerId !== undefined) {
      assetId = Number((await entry.contract.getOffer(parsed.args.offerId)).assetId);
    } else if (assetId == null && entry.name === "ProfitDistribution" && parsed.args?.roundId !== undefined) {
      assetId = Number((await entry.contract.getRound(parsed.args.roundId)).assetId);
    }
  } catch { /* the property stays unknown */ }

  // Stage
  let stage = METHOD_STAGE[method];
  if (method === "approve" && entry.name === "MockPaymentToken") stage = spenderStage(parsed.args[0], ctx);
  if (method === "setApprovalForAll" && String(parsed.args[0]).toLowerCase() === ctx.addresses.get("TokenMarketplace")) stage = "Listing";
  if (method === "permit") stage = spenderStage(parsed.args[1], ctx);
  if (!stage) stage = "Other";

  // A purchase from someone other than the property's owner is a resale.
  if (stage === "Purchase") {
    const sold = events.find((p) => p.name === "ListingPurchased" || p.name === "SignedOrderFilled");
    const issuer = assetId != null ? ctx.issuers.get(assetId) : null;
    if (sold && issuer && !sameAddress(sold.args.seller, issuer)) stage = "Resale";
  }

  // Who paid
  const from = receipt.from.toLowerCase();
  let payerCategory;
  if (method === "castVotesBySig") payerCategory = "Relayer";
  else if (OWNER_ONLY.has(method)) payerCategory = "Platform";
  else if (BUYER_METHODS.has(method) || (method === "approve" && stage === "Purchase")) payerCategory = ctx.platform.has(from) ? "Platform" : "Investor";
  else if (assetId != null && ctx.issuers.get(assetId) === from) payerCategory = "AssetOwner";
  else if (ctx.platform.has(from) && !(assetId != null && ctx.issuers.get(assetId) === from)) payerCategory = "Platform";
  else if (assetId == null && ctx.allIssuers.has(from) && method === "setApprovalForAll") payerCategory = "AssetOwner";
  else payerCategory = "Investor";

  return {
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    operationType: METHOD_OPERATION[method] || "AdminOperation",
    stage,
    contractName: entry.name,
    contractMethod: method,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.gasPrice,
    payerAddress: receipt.from,
    payerCategory,
    assetId,
    deployment: ctx.deployment,
  };
}
