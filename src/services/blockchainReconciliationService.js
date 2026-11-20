import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to load deployed contracts config
function loadContractConfig() {
  const possiblePaths = [
    path.join(__dirname, "../contracts/deployedContracts.json"),
    path.join(__dirname, "../contracts/localhost.json"),
    path.join(__dirname, "../../../shared/deployments/localhost.json"),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, "utf8"));
      } catch (err) {
        console.warn(`Failed reading deployment config at ${p}:`, err.message);
      }
    }
  }
  return null;
}

export class BlockchainReconciliationService {
  constructor() {
    const rpcUrl = process.env.BLOCKCHAIN_RPC_URL || "http://127.0.0.1:8545";
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.config = loadContractConfig();
  }

  getContracts() {
    if (!this.config || !this.config.contracts) {
      this.config = loadContractConfig();
    }
    if (!this.config || !this.config.contracts) {
      throw new Error("Deployed contract configuration not found. Please run deployment script.");
    }
    return this.config.contracts;
  }

  getAssetTokenContract() {
    const contracts = this.getContracts();
    return new ethers.Contract(
      contracts.AssetToken.address,
      contracts.AssetToken.abi,
      this.provider
    );
  }

  getAssetRegistryContract() {
    const contracts = this.getContracts();
    return new ethers.Contract(
      contracts.AssetRegistry.address,
      contracts.AssetRegistry.abi,
      this.provider
    );
  }

  /**
   * Verifies that a tokenization transaction was successfully mined on the blockchain,
   * checking receipt status, contract address, and parsing the AssetTokenized event.
   * 
   * @param {string} txHash Blockchain transaction hash
   * @param {number} expectedAssetId The asset ID being tokenized
   * @param {string} expectedRecipient The verified owner's wallet address
   * @returns {Promise<Object>} Verification details
   */
  async verifyTokenizationReceipt(txHash, expectedAssetId, expectedRecipient) {
    if (!txHash || !txHash.startsWith("0x")) {
      throw new Error("Invalid transaction hash format");
    }

    const receipt = await this.provider.getTransactionReceipt(txHash);
    if (!receipt) {
      throw new Error("Transaction receipt not found on chain. Transaction may still be pending.");
    }

    if (receipt.status !== 1) {
      throw new Error("Blockchain transaction failed or reverted.");
    }

    const contracts = this.getContracts();
    const tokenContractAddress = contracts.AssetToken.address.toLowerCase();

    // Verify interaction targeted the AssetToken contract
    const toAddress = (receipt.to || "").toLowerCase();
    if (toAddress !== tokenContractAddress) {
      // Check if it interacted through registry or another approved proxy
      const registryAddress = contracts.AssetRegistry.address.toLowerCase();
      if (toAddress !== registryAddress) {
        console.warn(`Receipt destination ${toAddress} is not AssetToken (${tokenContractAddress})`);
      }
    }

    // Parse logs for AssetTokenized event
    const assetTokenInterface = new ethers.Interface(contracts.AssetToken.abi);
    let tokenizedEventFound = false;
    let eventDetails = null;

    for (const log of receipt.logs) {
      try {
        const parsed = assetTokenInterface.parseLog({
          topics: log.topics,
          data: log.data,
        });

        if (parsed && parsed.name === "AssetTokenized") {
          const eventAssetId = Number(parsed.args[0]);
          const eventIssuer = parsed.args[1].toLowerCase();
          const eventShares = Number(parsed.args[2]);
          const eventURI = parsed.args[3];

          if (expectedAssetId && eventAssetId !== Number(expectedAssetId)) {
            throw new Error(
              `Receipt event assetId (${eventAssetId}) does not match expected asset (${expectedAssetId})`
            );
          }

          if (
            expectedRecipient &&
            eventIssuer !== expectedRecipient.toLowerCase()
          ) {
            throw new Error(
              `Minting recipient (${eventIssuer}) does not match verified owner (${expectedRecipient.toLowerCase()})`
            );
          }

          tokenizedEventFound = true;
          eventDetails = {
            assetId: eventAssetId,
            issuer: parsed.args[1],
            totalShares: eventShares,
            metadataURI: eventURI,
          };
          break;
        }
      } catch (err) {
        // Not an AssetToken log, continue
      }
    }

    if (!tokenizedEventFound) {
      throw new Error("Valid AssetTokenized event not found in transaction receipt logs.");
    }

    return {
      verified: true,
      blockNumber: receipt.blockNumber,
      gasUsed: Number(receipt.gasUsed),
      effectiveGasPrice: receipt.gasPrice ? receipt.gasPrice.toString() : "0",
      contractAddress: contracts.AssetToken.address,
      event: eventDetails,
    };
  }

  /**
   * Queries the authoritative token balance and supply directly from the blockchain.
   * 
   * @param {string} walletAddress Investor or owner wallet address
   * @param {number} assetId The asset / token ID
   * @returns {Promise<Object>} Authoritative balance & percentage breakdown
   */
  async getAuthoritativeTokenBalance(walletAddress, assetId) {
    const assetToken = this.getAssetTokenContract();
    const balance = await assetToken.balanceOf(walletAddress, assetId);
    const totalShares = await assetToken.totalShares(assetId);
    const isTokenized = await assetToken.isTokenized(assetId);

    const balanceNum = Number(balance);
    const totalNum = Number(totalShares);
    const ownershipPercentage = totalNum > 0 ? ((balanceNum / totalNum) * 100).toFixed(2) : "0.00";

    return {
      walletAddress,
      assetId: Number(assetId),
      balance: balanceNum,
      totalShares: totalNum,
      ownershipPercentage: parseFloat(ownershipPercentage),
      isTokenized,
      authoritativeSource: "Hardhat Localhost Blockchain (RPC)",
    };
  }

  /**
   * Queries authoritative asset status from AssetRegistry on-chain.
   * 
   * @param {number} assetId
   * @returns {Promise<Object>}
   */
  async getOnChainAssetStatus(assetId) {
    const registry = this.getAssetRegistryContract();
    const assetToken = this.getAssetTokenContract();

    const record = await registry.getAsset(assetId);
    const isTokenized = await assetToken.isTokenized(assetId);

    const statusMap = ["Pending", "Approved", "Tokenized", "Rejected"];

    return {
      assetId: Number(record.assetId),
      name: record.name,
      symbol: record.symbol,
      valuationLKR: Number(record.valuationLKR),
      totalShares: Number(record.totalShares),
      issuer: record.issuer,
      status: statusMap[Number(record.status)] || "Unknown",
      isTokenizedOnChain: isTokenized,
      metadataURI: record.metadataURI,
      documentHash: record.documentHash,
    };
  }
}

export default new BlockchainReconciliationService();
