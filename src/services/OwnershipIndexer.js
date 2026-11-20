import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OwnershipEvent from "../models/OwnershipEvent.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class OwnershipIndexer {
  constructor() {
    this.provider = null;
    this.assetTokenContract = null;
    this.chainId = 31337;
    this.lastProcessedBlock = 0;
    this.initialize();
  }

  initialize() {
    try {
      const rpcUrl = process.env.BLOCKCHAIN_RPC_URL || "http://127.0.0.1:8545";
      this.provider = new ethers.JsonRpcProvider(rpcUrl);

      const contractsPath = path.join(__dirname, "../contracts/deployedContracts.json");
      if (fs.existsSync(contractsPath)) {
        const contractsData = JSON.parse(fs.readFileSync(contractsPath, "utf8"));
        const tokenConfig = contractsData.contracts?.AssetToken;
        if (tokenConfig) {
          this.assetTokenContract = new ethers.Contract(
            tokenConfig.address,
            tokenConfig.abi,
            this.provider
          );
          this.contractAddress = tokenConfig.address.toLowerCase();
          this.chainId = contractsData.chainId || 31337;
        }
      }
    } catch (err) {
      console.warn("⚠ [OwnershipIndexer] Failed to initialize contract connection:", err.message);
    }
  }

  /**
   * Scans and syncs all TransferSingle and TransferBatch events up to current block.
   */
  async syncEvents(fromBlock = 0) {
    if (!this.assetTokenContract || !this.provider) {
      this.initialize();
      if (!this.assetTokenContract) {
        throw new Error("AssetToken contract not configured");
      }
    }

    const currentBlock = await this.provider.getBlockNumber();
    const startBlock = fromBlock > 0 ? fromBlock : this.lastProcessedBlock;

    console.log(`[OwnershipIndexer] Indexing blocks ${startBlock} to ${currentBlock}...`);

    // Query TransferSingle events
    const filterSingle = this.assetTokenContract.filters.TransferSingle();
    const singleEvents = await this.assetTokenContract.queryFilter(filterSingle, startBlock, currentBlock);

    // Query TransferBatch events
    const filterBatch = this.assetTokenContract.filters.TransferBatch();
    const batchEvents = await this.assetTokenContract.queryFilter(filterBatch, startBlock, currentBlock);

    let indexedCount = 0;

    // Process TransferSingle
    for (const evt of singleEvents) {
      const { operator, from, to, id, value } = evt.args;
      const block = await evt.getBlock();
      const isMint = from === ethers.ZeroAddress;
      const isBurn = to === ethers.ZeroAddress;

      const record = await OwnershipEvent.create({
        network: "localhost",
        chainId: this.chainId,
        contractAddress: this.contractAddress,
        assetId: Number(id),
        fromAddress: from.toLowerCase(),
        toAddress: to.toLowerCase(),
        amount: Number(value),
        txHash: evt.transactionHash,
        blockNumber: evt.blockNumber,
        blockTimestamp: block.timestamp,
        logIndex: evt.index,
        eventType: isMint ? "Mint" : isBurn ? "Burn" : "TransferSingle"
      });

      if (record) indexedCount++;
    }

    // Process TransferBatch
    for (const evt of batchEvents) {
      const { operator, from, to, ids, values } = evt.args;
      const block = await evt.getBlock();

      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const val = values[i];
        const isMint = from === ethers.ZeroAddress;
        const isBurn = to === ethers.ZeroAddress;

        const record = await OwnershipEvent.create({
          network: "localhost",
          chainId: this.chainId,
          contractAddress: this.contractAddress,
          assetId: Number(id),
          fromAddress: from.toLowerCase(),
          toAddress: to.toLowerCase(),
          amount: Number(val),
          txHash: evt.transactionHash,
          blockNumber: evt.blockNumber,
          blockTimestamp: block.timestamp,
          logIndex: evt.index + i,
          eventType: isMint ? "Mint" : isBurn ? "Burn" : "TransferBatch"
        });

        if (record) indexedCount++;
      }
    }

    this.lastProcessedBlock = currentBlock;
    console.log(`[OwnershipIndexer] Synced ${indexedCount} new ownership events. Current block: ${currentBlock}`);
    return { currentBlock, indexedCount };
  }
}

const indexerInstance = new OwnershipIndexer();
export default indexerInstance;
