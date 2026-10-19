import express from "express";
import { body, validationResult } from "express-validator";
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
  uploadAsset,
  verifyAsset,
  getAssetStatus,
  getUserAssets,
  getAllAssets,
  getAssetDetails,
  updateVerificationStatus,
  tokenizeAsset,
} from "../controllers/assetController.js";

import {
  getAssets,
  getAssetById,
  registerAsset,
  updateBlockchainStatus,
  getPlatformStats,
} from "../controllers/assetController.js";

import { Asset } from "../models/Asset.js";
import { protect, authorize } from "../middleware/auth.js";
import {
  upload,
  uploadToCloudinaryMiddleware,
} from "../middleware/upload.js";

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==========================================
// VALIDATION MIDDLEWARE
// ==========================================
const validate = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      errors: errors.array(),
    });
  }

  next();
};

const assetValidation = [
  body("assetName")
    .trim()
    .notEmpty()
    .withMessage("Asset name is required")
    .isLength({ min: 2 })
    .withMessage("Asset name must be at least 2 characters"),

  body("assetType")
    .trim()
    .notEmpty()
    .withMessage("Asset type is required")
    .isIn([
      "real_estate",
      "vehicle",
      "equipment",
      "intellectual_property",
      "other",
    ])
    .withMessage("Invalid asset type"),

  body("valuation")
    .notEmpty()
    .withMessage("Valuation is required")
    .isNumeric()
    .withMessage("Valuation must be a number")
    .isFloat({ min: 0 })
    .withMessage("Valuation must be non-negative"),

  body("currency")
    .optional()
    .isLength({ min: 3, max: 3 })
    .withMessage("Currency must be 3 characters (e.g., LKR)"),
];

// ==========================================
// BLOCKCHAIN CONFIGURATION
// ==========================================
const RPC_URL =
  process.env.BLOCKCHAIN_RPC_URL || "http://127.0.0.1:8545";

const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;

const getBlockchainContext = async (withSigner = false) => {
  const provider = new ethers.JsonRpcProvider(RPC_URL);

  let signer = null;

  if (withSigner) {
    if (!DEPLOYER_PRIVATE_KEY) {
      throw new Error(
        "DEPLOYER_PRIVATE_KEY is not configured"
      );
    }

    signer = new ethers.Wallet(
      DEPLOYER_PRIVATE_KEY,
      provider
    );
  }

  const deployedPath = path.resolve(
    __dirname,
    "../contracts/deployedContracts.json"
  );

  if (!fs.existsSync(deployedPath)) {
    throw new Error("Contract deployment not found");
  }

  const deployedData = JSON.parse(
    fs.readFileSync(deployedPath, "utf8")
  );

  const tokenInfo = deployedData.contracts?.AssetToken;

  if (!tokenInfo?.address || !tokenInfo?.abi) {
    throw new Error(
      "AssetToken deployment address or ABI is missing"
    );
  }

  const tokenContract = new ethers.Contract(
    tokenInfo.address,
    tokenInfo.abi,
    signer || provider
  );

  const paymentTokenInfo = deployedData.contracts?.MockPaymentToken;
  const paymentTokenContract = paymentTokenInfo
    ? new ethers.Contract(
        paymentTokenInfo.address,
        paymentTokenInfo.abi,
        signer || provider
      )
    : null;

  return { provider, signer, tokenContract, paymentTokenContract };
};

// ==========================================
// 1. ASSET VERIFICATION & DOCUMENT UPLOAD
// ==========================================

// Upload asset and supporting documents
router.post(
  "/upload",
  protect,
  upload.fields([
    { name: "deed", maxCount: 1 },
    { name: "surveyPlan", maxCount: 1 },
    { name: "extracts", maxCount: 1 },
    { name: "priorDeeds", maxCount: 1 },
    { name: "certificates", maxCount: 1 },
    { name: "document", maxCount: 1 },
  ]),
  uploadToCloudinaryMiddleware("asset-documents"),
  assetValidation,
  validate,
  uploadAsset
);

// Request asset verification
router.post("/verify/:assetId", protect, verifyAsset);

// Check verification status
router.get("/status/:assetId", protect, getAssetStatus);

// Get assets belonging to the authenticated user
router.get("/my-assets", protect, getUserAssets);

// Tokenize asset on blockchain (mint fractional ERC-1155 tokens)
router.post("/:assetId/tokenize", protect, tokenizeAsset);
router.post("/tokenize/:assetId", protect, tokenizeAsset);

// ==========================================
// 2. COMPLIANCE OFFICER / ADMIN ROUTES
// ==========================================

router.get(
  "/admin/all",
  protect,
  authorize("admin", "compliance_officer"),
  getAllAssets
);

router.get(
  "/admin/details/:assetId",
  protect,
  authorize("admin", "compliance_officer"),
  getAssetDetails
);

router.put(
  "/admin/status/:assetId",
  protect,
  authorize("admin", "compliance_officer"),
  updateVerificationStatus
);

// ==========================================
// 3. PUBLIC BLOCKCHAIN ASSET ROUTES
// ==========================================

// Get all tokenized/platform assets
router.get("/", getAssets);

// Platform statistics
router.get("/stats", getPlatformStats);

// ==========================================
// 4. DEVELOPMENT FAUCET
// ==========================================

router.post("/faucet", protect, async (req, res) => {
  try {
    const { address } = req.body;

    if (!address || !ethers.isAddress(address)) {
      return res.status(400).json({
        success: false,
        error: "Valid Ethereum wallet address required",
      });
    }

    const { provider, signer, tokenContract, paymentTokenContract } =
      await getBlockchainContext(true);

    // Send test ETH to the requested wallet
    const ethTx = await signer.sendTransaction({
      to: address,
      value: ethers.parseEther("1000"),
    });

    await ethTx.wait();

    let tokenTxHash = "";
    let musdTxHash = "";

    // Mint 10,000 mUSD payment liquidity to the requested wallet
    if (paymentTokenContract) {
      try {
        const mTx = await paymentTokenContract.mint(
          address,
          ethers.parseUnits("10000", 6)
        );
        const mReceipt = await mTx.wait();
        musdTxHash = mReceipt.hash;
      } catch (mErr) {
        console.warn("mUSD mint warning in faucet:", mErr.message);
      }
    }

    // Issue test property tokens if the deployer has enough
    if (
      address.toLowerCase() !==
      signer.address.toLowerCase()
    ) {
      const deployerBalance =
        await tokenContract.balanceOf(signer.address, 1);

      if (deployerBalance >= 200n) {
        const tokenTx =
          await tokenContract.safeTransferFrom(
            signer.address,
            address,
            1,
            200n,
            "0x"
          );

        const receipt = await tokenTx.wait();
        tokenTxHash = receipt.hash;
      }
    }

    return res.json({
      success: true,
      message: "Development faucet completed: Funded 1,000 ETH, 10,000 mUSD & property tokens",
      ethTxHash: ethTx.hash,
      musdTxHash,
      tokenTxHash,
    });
  } catch (error) {
    console.error("Faucet error:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==========================================
// 5. AVAILABLE TOKEN SHARES
// ==========================================

router.get("/:id/available", async (req, res) => {
  try {
    const assetId = Number(req.params.id);

    if (!Number.isSafeInteger(assetId) || assetId < 1) {
      return res.status(400).json({
        success: false,
        error: "Invalid asset ID",
      });
    }

    const { tokenContract } =
      await getBlockchainContext(false);

    const { signer } = await getBlockchainContext(true);

    const availableBalance =
      await tokenContract.balanceOf(signer.address, assetId);

    return res.json({
      success: true,
      available: Number(availableBalance),
    });
  } catch (error) {
    console.error("Available shares error:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==========================================
// 6. BUY FRACTIONAL SHARES
// ==========================================

router.post("/:id/buy", protect, async (req, res) => {
  try {
    const { buyerAddress, amount, paymentTxHash } = req.body;
    const assetId = Number(req.params.id);

    if (
      !buyerAddress ||
      !ethers.isAddress(buyerAddress) ||
      !Number.isSafeInteger(assetId) ||
      assetId < 1 ||
      amount === undefined ||
      !/^[1-9]\d*$/.test(String(amount))
    ) {
      return res.status(400).json({
        success: false,
        error: "Invalid purchase parameters",
      });
    }

    // Do not allow a user to specify a different buyer wallet
    // from the wallet associated with their authenticated account.
    // Implement this check using your actual user/wallet model.
    const sharesToBuy = BigInt(amount);

    const { signer, tokenContract } =
      await getBlockchainContext(true);

    const availableSupply =
      await tokenContract.balanceOf(
        signer.address,
        assetId
      );

    if (availableSupply < sharesToBuy) {
      return res.status(400).json({
        success: false,
        error: `Only ${availableSupply.toString()} shares available`,
      });
    }

    // IMPORTANT: Verify paymentTxHash and the buyer's wallet
    // ownership on the server before transferring real assets.
    // This demo route does not independently verify payment.

    const tx = await tokenContract.safeTransferFrom(
      signer.address,
      buyerAddress,
      assetId,
      sharesToBuy,
      "0x"
    );

    const receipt = await tx.wait();

    const remainingAvailable =
      await tokenContract.balanceOf(
        signer.address,
        assetId
      );

    const buyerBalance =
      await tokenContract.balanceOf(
        buyerAddress,
        assetId
      );

    return res.json({
      success: true,
      message: `Transferred ${amount} fractional shares`,
      txHash: receipt.hash,
      paymentTxHash: paymentTxHash || "",
      remainingAvailable: Number(remainingAvailable),
      buyerNewBalance: Number(buyerBalance),
    });
  } catch (error) {
    console.error("Purchase error:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==========================================
// 7. SWAP PROPERTY SHARES
// ==========================================

router.post("/swap", protect, async (req, res) => {
  try {
    const {
      userAddress,
      sourceAssetId,
      targetAssetId,
      sourceAmount,
      transferTxHash,
    } = req.body;

    const srcId = Number(sourceAssetId);
    const tgtId = Number(targetAssetId);

    if (
      !userAddress ||
      !ethers.isAddress(userAddress) ||
      !Number.isSafeInteger(srcId) ||
      !Number.isSafeInteger(tgtId) ||
      srcId < 1 ||
      tgtId < 1 ||
      srcId === tgtId ||
      !/^[1-9]\d*$/.test(String(sourceAmount))
    ) {
      return res.status(400).json({
        success: false,
        error: "Invalid swap parameters",
      });
    }

    const sourceShares = BigInt(sourceAmount);

    const sourceAsset = await Asset.findOne({
      assetId: srcId,
    });

    const targetAsset = await Asset.findOne({
      assetId: tgtId,
    });

    if (!sourceAsset || !targetAsset) {
      return res.status(404).json({
        success: false,
        error: "Source or target asset not found",
      });
    }

    const sourcePrice =
      sourceAsset.sharePriceLKR ??
      sourceAsset.valuationLKR / sourceAsset.totalShares;

    const targetPrice =
      targetAsset.sharePriceLKR ??
      targetAsset.valuationLKR / targetAsset.totalShares;

    if (
      !Number.isFinite(sourcePrice) ||
      !Number.isFinite(targetPrice) ||
      sourcePrice <= 0 ||
      targetPrice <= 0
    ) {
      return res.status(400).json({
        success: false,
        error: "Invalid asset share price",
      });
    }

    const totalValueLKR =
      Number(sourceShares) * sourcePrice;

    const targetAmount = Math.floor(
      totalValueLKR / targetPrice
    );

    if (
      !Number.isSafeInteger(targetAmount) ||
      targetAmount < 1
    ) {
      return res.status(400).json({
        success: false,
        error: "Swap value is too small",
      });
    }

    const targetShares = BigInt(targetAmount);

    const { signer, tokenContract } =
      await getBlockchainContext(true);

    const targetAvailable =
      await tokenContract.balanceOf(
        signer.address,
        tgtId
      );

    if (targetAvailable < targetShares) {
      return res.status(400).json({
        success: false,
        error: `Insufficient target asset liquidity. Available: ${targetAvailable.toString()}`,
      });
    }

    // IMPORTANT:
    // This preserves the original demo behavior of issuing target
    // shares. It does not transfer or lock source shares.
    // Verify the source transfer transaction and wallet ownership
    // before treating this as a real exchange.

    const tx = await tokenContract.safeTransferFrom(
      signer.address,
      userAddress,
      tgtId,
      targetShares,
      "0x"
    );

    const receipt = await tx.wait();

    const userSourceBalance =
      await tokenContract.balanceOf(userAddress, srcId);

    const userTargetBalance =
      await tokenContract.balanceOf(userAddress, tgtId);

    return res.json({
      success: true,
      message: `Transferred ${targetShares.toString()} ${targetAsset.symbol} shares`,
      txHash: receipt.hash,
      transferTxHash: transferTxHash || "",
      sourceSharesSpent: 0,
      targetSharesReceived: Number(targetShares),
      userSourceBalance: Number(userSourceBalance),
      userTargetBalance: Number(userTargetBalance),
    });
  } catch (error) {
    console.error("Swap error:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==========================================
// 8. BLOCKCHAIN ASSET DETAILS & REGISTRATION
// ==========================================

// Get an asset by its blockchain/database ID
router.get("/:id", getAssetById);

// Register a blockchain asset
router.post("/", protect, registerAsset);

// Update blockchain tokenization status
router.patch(
  "/:id/status",
  protect,
  authorize("admin", "compliance_officer"),
  updateBlockchainStatus
);

export default router;
