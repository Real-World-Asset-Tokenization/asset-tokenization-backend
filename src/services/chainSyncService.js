import { Asset } from "../models/Asset.js";
import { TokenizationRecord } from "../models/TokenizationRecord.js";
import blockchainReconciler from "./blockchainReconciliationService.js";

/**
 * Keeps the Azure asset records honest about the blockchain.
 *
 * The chain is the source of truth for "tokenized". A local Hardhat chain can be reset,
 * which erases registrations and tokens while Azure still says "Tokenized". This service
 * looks each asset up on the current chain (same deed hash + issuer + token supply) and:
 *   - tokenized on chain      -> status "Tokenized", blockchainAssetId set
 *   - registered, not minted  -> status "Approved" (if the document review was approved)
 *   - not on the chain at all -> status "Approved"/"Pending" and blockchainAssetId cleared,
 *                                so the owner can add it to the chain and tokenize again
 * If the chain cannot be reached nothing is changed: an outage must never downgrade data.
 */

const CHAIN_STATUS = ["pending", "approved", "tokenized", "rejected"];
const TTL_MS = 15_000;
let lastRun = 0;
let running = null;

// Current chain state for one asset record: { state, chainId }.
// state: "tokenized" | "approved" | "pending" | "rejected" | "missing"
export async function chainStateOf(asset, ctx) {
  const owner = (asset.issuerWallet || asset.ownerAddress || "").toLowerCase();
  if (!owner || !asset.documentHash) return { state: "missing", chainId: null };
  const ids = await ctx.idsByIssuer(owner);
  for (const id of ids) {
    const record = await ctx.record(id);
    if (record.documentHash === asset.documentHash && record.issuer.toLowerCase() === owner &&
        Number(record.totalShares) === Number(asset.totalShares)) {
      const minted = await ctx.isTokenized(id);
      const status = CHAIN_STATUS[Number(record.status)] || "pending";
      return { state: minted ? "tokenized" : status === "tokenized" ? "approved" : status, chainId: Number(record.assetId) };
    }
  }
  return { state: "missing", chainId: null };
}

function chainContext() {
  const registry = blockchainReconciler.getAssetRegistryContract();
  const token = blockchainReconciler.getAssetTokenContract();
  const byIssuer = new Map(), records = new Map(), minted = new Map();
  const memo = (map, key, fn) => { if (!map.has(key)) map.set(key, fn()); return map.get(key); };
  return {
    ping: () => registry.getAllAssetIds(),
    idsByIssuer: (w) => memo(byIssuer, w, () => registry.getAssetsByIssuer(w)),
    record: (id) => memo(records, String(id), () => registry.getAsset(id)),
    isTokenized: (id) => memo(minted, String(id), () => token.isTokenized(id)),
  };
}

// Brings one asset document in line with the chain. Returns the chain state.
async function syncOne(asset, ctx) {
  const { state, chainId } = await chainStateOf(asset, ctx);
  const set = {}, unset = {};
  if (state === "tokenized") {
    if (asset.status !== "Tokenized") set.status = "Tokenized";
    if (asset.blockchainAssetId !== chainId) set.blockchainAssetId = chainId;
  } else {
    if (asset.status === "Tokenized") {
      set.status = asset.verificationStatus === "approved" || state === "approved" ? "Approved" : "Pending";
      unset.tokenizedAt = "";
    }
    if ((asset.blockchainAssetId ?? null) !== chainId) {
      if (chainId == null) unset.blockchainAssetId = ""; else set.blockchainAssetId = chainId;
    }
  }
  if (Object.keys(set).length || Object.keys(unset).length) {
    await Asset.updateOne({ _id: asset._id }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) });
    if (state !== "tokenized") {
      await TokenizationRecord.updateOne(
        { assetId: Number(asset.assetId), tokenizationStatus: "TOKENIZED" },
        { $set: { tokenizationStatus: "VERIFIED" } },
      ).catch(() => {});
    }
    console.log(`[chain-sync] ${asset.name || asset.assetName} (#${asset.assetId}): chain=${state}`, set, Object.keys(unset));
  }
  return { state, chainId };
}

/**
 * Sync every asset with the chain, at most once per TTL (concurrent callers share a run).
 * Returns Map(assetId -> { state, chainId }) or null when the chain is unreachable.
 */
export async function syncAllWithChain({ force = false } = {}) {
  if (running) return running;
  if (!force && Date.now() - lastRun < TTL_MS && syncAllWithChain.cache) return syncAllWithChain.cache;
  running = (async () => {
    const ctx = chainContext();
    try { await ctx.ping(); } catch { return null; } // chain down: change nothing
    const assets = await Asset.find({});
    const out = new Map();
    for (const asset of assets) {
      try { out.set(Number(asset.assetId), await syncOne(asset, ctx)); } catch (e) { /* leave this one as is */ }
    }
    lastRun = Date.now();
    syncAllWithChain.cache = out;
    return out;
  })().finally(() => { running = null; });
  return running;
}

// Chain state for API responses ("unknown" when the chain could not be read).
export const chainStatusFor = (states, assetId) => (states ? states.get(Number(assetId))?.state || "missing" : "unknown");

export function invalidateChainSync() { lastRun = 0; syncAllWithChain.cache = null; }
