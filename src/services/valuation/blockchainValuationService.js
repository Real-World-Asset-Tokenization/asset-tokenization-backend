import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Reads valuation state from the chain and publishes approved valuations through
// AssetValuationRegistry. The chain is the source of truth for the official value.

const deployedPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../contracts/deployedContracts.json");
const STATUS = ["Pending", "Approved", "Tokenized", "Rejected"];
const LKR = ethers.encodeBytes32String("LKR");
const ERC20_DECIMALS = ["function decimals() view returns (uint8)"];

let override = null;          // tests inject { rpcUrl, privateKey, contracts }
let cache = { key: null };
let sendQueue = Promise.resolve(); // one transaction at a time from the publisher key (nonce safety)

export function configure(config) { override = config; cache = { key: null }; }

function load() {
  const rpcUrl = override?.rpcUrl || process.env.BLOCKCHAIN_RPC_URL || "http://127.0.0.1:8545";
  const privateKey = override?.privateKey || process.env.VALUATION_PUBLISHER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  let contracts = override?.contracts;
  let key = `${rpcUrl}|${privateKey}`;
  if (!contracts) {
    const stat = fs.statSync(deployedPath);
    key += `|${stat.mtimeMs}`;
    if (cache.key === key) return cache;
    contracts = JSON.parse(fs.readFileSync(deployedPath, "utf8")).contracts;
  } else if (cache.key === key) return cache;

  if (!contracts.AssetValuationRegistry) {
    throw new Error("AssetValuationRegistry is not deployed. Run: npx hardhat run scripts/deploy_valuation_registry.js --network localhost");
  }
  // cacheTimeout -1: never reuse a cached read; right after publishing we must see the new block.
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true, cacheTimeout: -1 });
  const signer = privateKey ? new ethers.Wallet(privateKey, provider) : null;
  const make = (name, runner) => new ethers.Contract(contracts[name].address, contracts[name].abi, runner);
  cache = {
    key, provider, signer,
    addresses: Object.fromEntries(Object.entries(contracts).map(([k, v]) => [k, v.address])),
    registry: make("AssetRegistry", provider),
    token: make("AssetToken", provider),
    valuation: make("AssetValuationRegistry", provider),
    valuationSigned: signer ? make("AssetValuationRegistry", signer) : null,
    marketplace: contracts.TokenMarketplace ? make("TokenMarketplace", provider) : null,
  };
  return cache;
}

const recordToJson = (r) => ({
  version: Number(r.version),
  valuation: r.valuation.toString(),
  currency: ethers.decodeBytes32String(r.currency),
  effectiveDate: new Date(Number(r.effectiveDate) * 1000).toISOString(),
  reportHash: r.reportHash,
  proposalRef: r.proposalRef,
  previousValuation: r.previousValuation.toString(),
  tokenSupply: r.tokenSupply.toString(),
  publisher: r.publisher,
  publishedAt: new Date(Number(r.publishedAt) * 1000).toISOString(),
});

export async function readAssetState(assetId) {
  const c = load();
  const a = await c.registry.getAsset(assetId); // reverts "Asset does not exist"
  const [supply, latestVersion, history] = await Promise.all([
    c.token.totalShares(assetId),
    c.valuation.latestVersion(assetId),
    c.valuation.getHistory(assetId),
  ]);
  const latest = history.length ? recordToJson(history[history.length - 1]) : null;
  return {
    assetId: Number(assetId),
    name: a.name,
    symbol: a.symbol,
    status: STATUS[Number(a.status)],
    issuer: a.issuer,
    valuation: a.valuationLKR.toString(),
    tokenSupply: supply.toString(),
    tokenContract: c.addresses.AssetToken,
    valuationRegistry: c.addresses.AssetValuationRegistry,
    registeredAt: new Date(Number(a.createdAt) * 1000).toISOString(),
    latestVersion: Number(latestVersion),
    latestRecord: latest,
    // False if someone changed AssetRegistry directly, bypassing the versioned registry.
    registryInSync: latest ? latest.valuation === a.valuationLKR.toString() : true,
  };
}

export async function listAssetIds() {
  return (await load().registry.getAllAssetIds()).map(Number);
}

// Published versions with the transaction that created each one.
export async function getOnChainHistory(assetId) {
  const c = load();
  const [records, events] = await Promise.all([
    c.valuation.getHistory(assetId),
    c.valuation.queryFilter(c.valuation.filters.ValuationPublished(assetId)),
  ]);
  const byVersion = new Map(events.map((e) => [Number(e.args.version), e]));
  return records.map((r) => {
    const e = byVersion.get(Number(r.version));
    return { ...recordToJson(r), transactionHash: e?.transactionHash || null, blockNumber: e?.blockNumber ?? null };
  });
}

export async function findPublication(assetId, version) {
  if (version < 1) return null;
  const history = await getOnChainHistory(assetId);
  return history.find((h) => h.version === version) || null;
}

export async function publisherHasRole() {
  const c = load();
  if (!c.signer) return false;
  return c.valuation.hasRole(await c.valuation.VALUATION_PUBLISHER_ROLE(), c.signer.address);
}

// Sends the publication. onSubmitted(hash) runs as soon as the tx is broadcast, so a
// crash after that point can be reconciled from the chain instead of re-sent.
export async function publishValuation({ assetId, version, valuation, effectiveDate, reportHash, proposalRef }, onSubmitted) {
  const c = load();
  if (!c.valuationSigned) throw new Error("No valuation publisher key configured");
  const run = async () => {
    const tx = await c.valuationSigned.publishValuation(
      assetId, version, BigInt(valuation), LKR,
      Math.floor(new Date(effectiveDate).getTime() / 1000), reportHash, proposalRef
    );
    if (onSubmitted) await onSubmitted(tx.hash);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error("Valuation transaction reverted");
    const event = receipt.logs.map((l) => { try { return c.valuation.interface.parseLog(l); } catch { return null; } })
      .find((p) => p?.name === "ValuationPublished");
    if (!event || Number(event.args.version) !== Number(version)) throw new Error("Valuation event missing from receipt");
    return { transactionHash: receipt.hash, blockNumber: receipt.blockNumber };
  };
  const result = sendQueue.then(run, run);
  sendQueue = result.catch(() => {});
  return result;
}

// Last completed marketplace trade (not an asking price). Independent of the reference price.
export async function lastTrade(assetId) {
  const c = load();
  if (!c.marketplace) return null;
  const events = await c.marketplace.queryFilter(c.marketplace.filters.ListingPurchased());
  const trades = events.filter((e) => Number(e.args.assetId) === Number(assetId));
  if (!trades.length) return null;
  const t = trades[trades.length - 1];
  const decimals = await new ethers.Contract(t.args.paymentToken, ERC20_DECIMALS, c.provider).decimals();
  const block = await c.provider.getBlock(t.blockNumber);
  return {
    pricePerToken: ethers.formatUnits(t.args.totalPrice / t.args.amount, decimals),
    currency: "mUSD",
    amount: Number(t.args.amount),
    tradedAt: new Date(block.timestamp * 1000).toISOString(),
    transactionHash: t.transactionHash,
  };
}

export const hashText = (text) => ethers.keccak256(ethers.toUtf8Bytes(String(text)));
export const hashBytes = (buf) => ethers.keccak256(buf);
