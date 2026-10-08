import express from "express";
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  getAssets,
  getAssetById,
  registerAsset,
  updateAssetStatus,
  getPlatformStats
} from "../controllers/assetController.js";
import { Asset } from "../models/Asset.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

router.get("/", getAssets);
router.get("/stats", getPlatformStats);
router.post("/faucet", async (req, res) => {
  try {
    const { address } = req.body;
    if (!address || !ethers.isAddress(address)) {
      return res.status(400).json({ success: false, error: "Valid Ethereum wallet address required" });
    }

    const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
    const deployer = new ethers.Wallet(
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      provider
    );

    // Send 1000 ETH to user's wallet
    let nonce = await provider.getTransactionCount(deployer.address, "latest");
    const txEth = await deployer.sendTransaction({
      to: address,
      value: ethers.parseEther("1000.0"),
      nonce: nonce++
    });
    await txEth.wait();

    // Read contract deployment JSON
    const deployedPath = path.join(__dirname, "../contracts/deployedContracts.json");
    let tokenTxHash = "";
    if (fs.existsSync(deployedPath)) {
      const deployedData = JSON.parse(fs.readFileSync(deployedPath, "utf8"));
      const tokenAddress = deployedData.contracts.AssetToken.address;
      const tokenAbi = deployedData.contracts.AssetToken.abi;
      const tokenContract = new ethers.Contract(tokenAddress, tokenAbi, deployer);

      const bal = await tokenContract.balanceOf(deployer.address, 1);
      if (bal >= 200n && address.toLowerCase() !== deployer.address.toLowerCase()) {
        const txTokens = await tokenContract.safeTransferFrom(
          deployer.address,
          address,
          1,
          200n,
          "0x",
          { nonce }
        );
        const receipt = await txTokens.wait();
        tokenTxHash = receipt.hash;
      }
    }

    res.json({
      success: true,
      message: "Funded 500 ETH and 200 property tokens successfully!",
      ethTxHash: txEth.hash,
      tokenTxHash
    });
  } catch (error) {
    console.error("Faucet error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/:id/available", async (req, res) => {
  try {
    const assetId = Number(req.params.id);
    const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
    const deployerAddress = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
    const deployedPath = path.join(__dirname, "../contracts/deployedContracts.json");
    if (!fs.existsSync(deployedPath)) {
      return res.json({ success: true, available: 0 });
    }
    const deployedData = JSON.parse(fs.readFileSync(deployedPath, "utf8"));
    const tokenContract = new ethers.Contract(
      deployedData.contracts.AssetToken.address,
      deployedData.contracts.AssetToken.abi,
      provider
    );
    const bal = await tokenContract.balanceOf(deployerAddress, assetId);
    res.json({ success: true, available: Number(bal) });
  } catch (err) {
    res.json({ success: true, available: 0 });
  }
});

router.post("/:id/buy", async (req, res) => {
  try {
    const { buyerAddress, amount, paymentTxHash } = req.body;
    const assetId = Number(req.params.id);
    const sharesToBuy = BigInt(amount);

    if (!buyerAddress || !amount || Number(amount) <= 0) {
      return res.status(400).json({ success: false, error: "Invalid purchase parameters" });
    }

    const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
    const deployer = new ethers.Wallet(
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      provider
    );

    const deployedPath = path.join(__dirname, "../contracts/deployedContracts.json");
    if (!fs.existsSync(deployedPath)) {
      return res.status(500).json({ success: false, error: "Contract deployment not found" });
    }

    const deployedData = JSON.parse(fs.readFileSync(deployedPath, "utf8"));
    const tokenContract = new ethers.Contract(
      deployedData.contracts.AssetToken.address,
      deployedData.contracts.AssetToken.abi,
      deployer
    );

    const availableSupply = await tokenContract.balanceOf(deployer.address, assetId);
    if (availableSupply < sharesToBuy) {
      return res.status(400).json({
        success: false,
        error: `Only ${availableSupply.toString()} shares available in primary issuance for this property.`
      });
    }

    let nonce = await provider.getTransactionCount(deployer.address, "latest");
    const tx = await tokenContract.safeTransferFrom(
      deployer.address,
      buyerAddress,
      assetId,
      sharesToBuy,
      "0x",
      { nonce }
    );
    const receipt = await tx.wait();

    const remainingAvailable = await tokenContract.balanceOf(deployer.address, assetId);
    const buyerNewBal = await tokenContract.balanceOf(buyerAddress, assetId);

    res.json({
      success: true,
      message: `Successfully purchased ${amount} fractional shares!`,
      txHash: receipt.hash,
      paymentTxHash: paymentTxHash || "",
      remainingAvailable: Number(remainingAvailable),
      buyerNewBalance: Number(buyerNewBal)
    });
  } catch (error) {
    console.error("Purchase error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post("/swap", async (req, res) => {
  try {
    const { userAddress, sourceAssetId, targetAssetId, sourceAmount, transferTxHash } = req.body;
    const srcId = Number(sourceAssetId);
    const tgtId = Number(targetAssetId);
    const srcAmt = BigInt(sourceAmount);

    if (!userAddress || srcAmt <= 0n || srcId === tgtId) {
      return res.status(400).json({ success: false, error: "Invalid swap parameters" });
    }

    const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
    const deployer = new ethers.Wallet(
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      provider
    );

    const deployedPath = path.join(__dirname, "../contracts/deployedContracts.json");
    if (!fs.existsSync(deployedPath)) {
      return res.status(500).json({ success: false, error: "Contract deployment not found" });
    }

    const deployedData = JSON.parse(fs.readFileSync(deployedPath, "utf8"));
    const tokenContract = new ethers.Contract(
      deployedData.contracts.AssetToken.address,
      deployedData.contracts.AssetToken.abi,
      deployer
    );

    // Get asset details from DB
    const sourceAsset = await Asset.findOne({ assetId: srcId });
    const targetAsset = await Asset.findOne({ assetId: tgtId });

    if (!sourceAsset || !targetAsset) {
      return res.status(404).json({ success: false, error: "Source or Target asset not found" });
    }

    const srcPrice = sourceAsset.sharePriceLKR || (sourceAsset.valuationLKR / sourceAsset.totalShares);
    const tgtPrice = targetAsset.sharePriceLKR || (targetAsset.valuationLKR / targetAsset.totalShares);

    // Value exchanged in LKR
    const totalValLKR = Number(srcAmt) * srcPrice;
    const targetSharesToReceive = BigInt(Math.max(1, Math.floor(totalValLKR / tgtPrice)));

    // Verify deployer has target tokens to issue
    const deployerTgtBal = await tokenContract.balanceOf(deployer.address, tgtId);
    if (deployerTgtBal < targetSharesToReceive) {
      return res.status(400).json({
        success: false,
        error: `Insufficient liquidity in target property #${tgtId}. Available: ${deployerTgtBal.toString()} shares.`
      });
    }

    // Transfer target shares to the user
    let nonce = await provider.getTransactionCount(deployer.address, "latest");
    const tx = await tokenContract.safeTransferFrom(
      deployer.address,
      userAddress,
      tgtId,
      targetSharesToReceive,
      "0x",
      { nonce }
    );
    const receipt = await tx.wait();

    const userNewSrcBal = await tokenContract.balanceOf(userAddress, srcId);
    const userNewTgtBal = await tokenContract.balanceOf(userAddress, tgtId);

    res.json({
      success: true,
      message: `Successfully exchanged ${sourceAmount} ${sourceAsset.symbol} tokens for ${targetSharesToReceive.toString()} ${targetAsset.symbol} shares!`,
      txHash: receipt.hash,
      sourceSharesSpent: Number(sourceAmount),
      targetSharesReceived: Number(targetSharesToReceive),
      userSourceBalance: Number(userNewSrcBal),
      userTargetBalance: Number(userNewTgtBal)
    });
  } catch (error) {
    console.error("Swap error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/:id", getAssetById);
router.post("/", registerAsset);
router.patch("/:id/status", updateAssetStatus);

export default router;
