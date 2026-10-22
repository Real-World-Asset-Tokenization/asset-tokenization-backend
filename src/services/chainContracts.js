import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONTRACTS_FILE = path.join(__dirname, "../contracts/deployedContracts.json");

const DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/**
 * Reads the current deployment (it is re-read on every call because redeploying rewrites the file)
 * and returns contract instances. `withSigner` uses the platform wallet, which owns PropertySale.
 */
export function loadChain({ withSigner = false } = {}) {
  const data = JSON.parse(fs.readFileSync(process.env.DEPLOYED_CONTRACTS_FILE || DEFAULT_CONTRACTS_FILE, "utf8"));
  const provider = new ethers.JsonRpcProvider(process.env.BLOCKCHAIN_RPC_URL || "http://127.0.0.1:8545");
  const runner = withSigner ? new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY || DEV_KEY, provider) : provider;

  const make = (name) => {
    const config = data.contracts?.[name];
    if (!config) throw new Error(`${name} is not in the deployment file. Redeploy the contracts.`);
    return new ethers.Contract(config.address, config.abi, runner);
  };

  return {
    provider,
    runner,
    chainId: Number(data.chainId || 31337),
    addresses: Object.fromEntries(Object.entries(data.contracts || {}).map(([k, v]) => [k, v.address])),
    marketplace: make("TokenMarketplace"),
    // The marketplace this one replaced, if any: its offers can no longer be filled but can be carried over.
    previousMarketplace: (data.previousTokenMarketplaces || []).length
      ? new ethers.Contract(data.previousTokenMarketplaces.at(-1), data.contracts.TokenMarketplace.abi, runner)
      : null,
    sale: make("PropertySale"),
    assetToken: make("AssetToken"),
    paymentToken: make("MockPaymentToken"),
    destroy: () => provider.destroy?.(),
  };
}

export const ORDER_TYPES = {
  Order: [
    { name: "seller", type: "address" },
    { name: "assetId", type: "uint256" },
    { name: "amount", type: "uint256" },
    { name: "pricePerToken", type: "uint256" },
    { name: "paymentToken", type: "address" },
    { name: "expiry", type: "uint256" },
    { name: "salt", type: "uint256" },
  ],
};

// An offer that follows the property's approved price: no fixed price, a premium and a floor instead.
export const FOLLOW_ORDER_TYPES = {
  FollowOrder: [
    { name: "seller", type: "address" },
    { name: "assetId", type: "uint256" },
    { name: "amount", type: "uint256" },
    { name: "premiumBps", type: "int256" },
    { name: "floorPrice", type: "uint256" },
    { name: "paymentToken", type: "address" },
    { name: "expiry", type: "uint256" },
    { name: "salt", type: "uint256" },
  ],
};

export const VOTE_TYPES = {
  Vote: [
    { name: "offerId", type: "uint256" },
    { name: "support", type: "uint8" },
  ],
};

export const marketplaceDomain = (chain) => ({
  name: "TokenMarketplace",
  version: "1",
  chainId: chain.chainId,
  verifyingContract: chain.addresses.TokenMarketplace,
});

export const saleDomain = (chain) => ({
  name: "PropertySale",
  version: "1",
  chainId: chain.chainId,
  verifyingContract: chain.addresses.PropertySale,
});

/**
 * Raw deployment data plus a read-only provider, for code that must decode transactions sent to any
 * deployed contract (the gas indexer). Re-read on every call because redeploying rewrites the file.
 */
export function loadDeployment() {
  const data = JSON.parse(fs.readFileSync(process.env.DEPLOYED_CONTRACTS_FILE || DEFAULT_CONTRACTS_FILE, "utf8"));
  const provider = new ethers.JsonRpcProvider(process.env.BLOCKCHAIN_RPC_URL || "http://127.0.0.1:8545");
  return { data, provider, deployment: String(data.contracts?.AssetRegistry?.address || "").toLowerCase() };
}
