import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load deployed contracts
const loadContracts = () => {
  try {
    const contractsPath = path.join(__dirname, '../contracts/deployedContracts.json');
    const contractsData = JSON.parse(fs.readFileSync(contractsPath, 'utf8'));
    return contractsData.contracts;
  } catch (error) {
    console.error('Failed to load contracts:', error);
    return null;
  }
};

class BlockchainService {
  constructor() {
    this.contracts = loadContracts();
    this.provider = null;
    this.signer = null;
    this.registry = null;
    this.assetToken = null;
    this.initialize();
  }

  initialize() {
    try {
      // Connect to local Hardhat node
      this.provider = new ethers.JsonRpcProvider(process.env.BLOCKCHAIN_RPC_URL || 'http://localhost:8545');
      
      // Use a deployer private key (in production, this should be from secure storage)
      const privateKey = process.env.DEPLOYER_PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
      this.signer = new ethers.Wallet(privateKey, this.provider);

      if (this.contracts) {
        // Initialize contract instances
        this.registry = new ethers.Contract(
          this.contracts.AssetRegistry.address,
          this.contracts.AssetRegistry.abi,
          this.signer
        );

        this.assetToken = new ethers.Contract(
          this.contracts.AssetToken.address,
          this.contracts.AssetToken.abi,
          this.signer
        );

        console.log('Blockchain service initialized successfully');
        console.log('Registry address:', this.contracts.AssetRegistry.address);
        console.log('AssetToken address:', this.contracts.AssetToken.address);
      }
    } catch (error) {
      console.error('Failed to initialize blockchain service:', error);
    }
  }

  /**
   * Register an asset on the blockchain
   */
  async registerAsset(assetData) {
    try {
      if (!this.registry) {
        throw new Error('Registry contract not initialized');
      }

      console.log('Registering asset on blockchain:', assetData.name);

      const tx = await this.registry.registerAsset(
        assetData.name,
        assetData.symbol,
        assetData.metadataURI,
        assetData.documentHash,
        ethers.parseUnits(assetData.valuationLKR.toString(), 0), // Use wei for LKR
        assetData.totalShares
      );

      const receipt = await tx.wait();
      const assetId = this.extractAssetIdFromReceipt(receipt);

      console.log('Asset registered on blockchain with ID:', assetId);
      return { success: true, assetId, txHash: receipt.hash };
    } catch (error) {
      console.error('Failed to register asset on blockchain:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Approve an asset on the blockchain
   */
  async approveAsset(assetId) {
    try {
      if (!this.registry) {
        throw new Error('Registry contract not initialized');
      }

      console.log('Approving asset on blockchain:', assetId);

      const tx = await this.registry.approveAsset(assetId);
      const receipt = await tx.wait();

      console.log('Asset approved on blockchain');
      return { success: true, txHash: receipt.hash };
    } catch (error) {
      console.error('Failed to approve asset on blockchain:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Tokenize an asset on the blockchain
   */
  async tokenizeAsset(assetId, issuerAddress) {
    try {
      if (!this.assetToken) {
        throw new Error('AssetToken contract not initialized');
      }

      console.log('Tokenizing asset on blockchain:', assetId, 'for issuer:', issuerAddress);

      const tx = await this.assetToken.tokenizeAsset(assetId, issuerAddress);
      const receipt = await tx.wait();

      console.log('Asset tokenized on blockchain');
      return { success: true, txHash: receipt.hash };
    } catch (error) {
      console.error('Failed to tokenize asset on blockchain:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Full tokenization flow: Register → Approve → Tokenize
   */
  async fullTokenizationFlow(assetData, issuerAddress) {
    try {
      // Step 1: Register asset
      const registerResult = await this.registerAsset(assetData);
      if (!registerResult.success) {
        return registerResult;
      }

      const assetId = registerResult.assetId;

      // Step 2: Approve asset
      const approveResult = await this.approveAsset(assetId);
      if (!approveResult.success) {
        return approveResult;
      }

      // Step 3: Tokenize asset
      const tokenizeResult = await this.tokenizeAsset(assetId, issuerAddress);
      if (!tokenizeResult.success) {
        return tokenizeResult;
      }

      return {
        success: true,
        assetId,
        registerTxHash: registerResult.txHash,
        approveTxHash: approveResult.txHash,
        tokenizeTxHash: tokenizeResult.txHash
      };
    } catch (error) {
      console.error('Full tokenization flow failed:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Extract asset ID from transaction receipt
   */
  extractAssetIdFromReceipt(receipt) {
    // Look for AssetRegistered event
    const event = receipt.logs.find(log => {
      try {
        const parsed = this.registry.interface.parseLog(log);
        return parsed && parsed.name === 'AssetRegistered';
      } catch (e) {
        return false;
      }
    });

    if (event) {
      const parsed = this.registry.interface.parseLog(event);
      return parsed.args.assetId.toString();
    }

    // Fallback: if event not found, throw error
    throw new Error('AssetRegistered event not found in transaction receipt');
  }

  /**
   * Get asset details from blockchain
   */
  async getAssetDetails(assetId) {
    try {
      if (!this.registry) {
        throw new Error('Registry contract not initialized');
      }

      const asset = await this.registry.getAsset(assetId);
      return { success: true, asset };
    } catch (error) {
      console.error('Failed to get asset details:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Check if blockchain node is connected
   */
  async isConnected() {
    try {
      const blockNumber = await this.provider.getBlockNumber();
      return blockNumber >= 0;
    } catch (error) {
      return false;
    }
  }
}

export default new BlockchainService();
