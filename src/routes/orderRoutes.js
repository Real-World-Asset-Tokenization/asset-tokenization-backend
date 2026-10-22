import express from "express";
import { ethers } from "ethers";
import { Asset } from "../models/Asset.js";
import User from "../models/User.js";
import { SignedOrder } from "../models/SignedOrder.js";
import { protect } from "../middleware/auth.js";
import { requireDatabase } from "../middleware/requireDatabase.js";
import { loadChain, ORDER_TYPES, FOLLOW_ORDER_TYPES, marketplaceDomain } from "../services/chainContracts.js";

const router = express.Router();
router.use(requireDatabase);

const sameAddress = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();

/**
 * GET /api/orders?assetId=
 * Open signed orders in the same shape as on-chain listings (plus kind: "signed"), so the
 * marketplace can show both together. Each order is checked against the chain, so what is
 * returned can actually be filled: not cancelled, not expired, and the seller still holds the
 * tokens and still approves the marketplace.
 */
router.get("/", async (req, res) => {
  let chain;
  try {
    chain = loadChain();
    const now = Math.floor(Date.now() / 1000);
    const filter = { status: "Active" };
    if (req.query.assetId !== undefined) filter.assetId = Number(req.query.assetId);
    // Orders signed for an earlier marketplace deployment can no longer be filled.
    filter.marketplace = chain.addresses.TokenMarketplace.toLowerCase();
    const orders = await SignedOrder.find(filter).sort({ createdAt: -1 }).lean();

    const data = [];
    for (const o of orders) {
      if (o.expiry && o.expiry <= now) continue;
      const [filled, cancelled, balance, approved] = await Promise.all([
        chain.marketplace.orderFilled(o.orderHash),
        chain.marketplace.orderCancelled(o.orderHash),
        chain.assetToken.balanceOf(o.seller, o.assetId),
        chain.assetToken.isApprovedForAll(o.seller, chain.addresses.TokenMarketplace),
      ]);
      if (cancelled || !approved) continue;
      let remaining = BigInt(o.amount) - filled;
      if (balance < remaining) remaining = balance;
      if (remaining <= 0n) continue;

      const follows = o.kind === "follow";
      let currentPrice = BigInt(o.pricePerToken);
      let wireOrder = {
        seller: ethers.getAddress(o.seller),
        assetId: String(o.assetId),
        amount: String(o.amount),
        pricePerToken: o.pricePerToken,
        paymentToken: o.paymentToken,
        expiry: String(o.expiry || 0),
        salt: o.salt,
      };
      if (follows) {
        wireOrder = {
          seller: wireOrder.seller, assetId: wireOrder.assetId, amount: wireOrder.amount,
          premiumBps: String(o.premiumBps), floorPrice: o.floorPrice,
          paymentToken: o.paymentToken, expiry: wireOrder.expiry, salt: o.salt,
        };
        try {
          // Worked out now from the published valuation. Below the seller's floor, the offer is not for sale.
          currentPrice = await chain.marketplace.followPrice(wireOrder);
        } catch {
          continue;
        }
      }

      const assetDoc = await Asset.findOne({ $or: [{ blockchainAssetId: o.assetId }, { assetId: o.assetId }] });
      data.push({
        kind: "signed",
        listingId: `S-${o.orderHash.slice(2, 8).toUpperCase()}`,
        orderHash: o.orderHash,
        order: wireOrder,
        follow: follows,
        premiumBps: follows ? o.premiumBps : null,
        floorPriceBase: follows ? o.floorPrice : null,
        signature: o.signature,
        seller: ethers.getAddress(o.seller),
        assetId: o.assetId,
        assetName: assetDoc?.name || assetDoc?.assetName || `Asset #${o.assetId}`,
        assetSymbol: assetDoc?.symbol || `RWA-${o.assetId}`,
        location: assetDoc?.location || "Sri Lanka",
        imageUrl: assetDoc?.imageUrl || "",
        totalShares: assetDoc?.totalShares || null,
        amount: Number(remaining),
        pricePerTokenBase: currentPrice.toString(),
        pricePerTokenFormatted: Number(ethers.formatUnits(currentPrice, 6)),
        paymentToken: o.paymentToken,
        createdAt: Math.floor(new Date(o.createdAt).getTime() / 1000),
        expiresAt: o.expiry || 0,
        status: 0,
        statusLabel: "Active",
      });
    }
    res.json({ success: true, count: data.length, data });
  } catch (err) {
    res.status(503).json({ success: false, message: "Unable to read signed orders", error: err.message });
  } finally {
    chain?.destroy();
  }
});

/**
 * GET /api/orders/stale
 * The signed-in seller's offers that were signed for an earlier marketplace contract. They can no longer be
 * filled, but the tokens they offered are still in the seller's wallet, so the seller can sign them again.
 * Returns what is left of each one (offered minus what was already bought, capped by the wallet balance).
 */
router.get("/stale", protect, async (req, res) => {
  let chain;
  try {
    const user = await User.findById(req.user.userId);
    if (!user?.walletAddress) return res.json({ success: true, count: 0, data: [] });
    chain = loadChain();
    const old = chain.previousMarketplace;
    if (!old) return res.json({ success: true, count: 0, data: [] });

    const now = Math.floor(Date.now() / 1000);
    const orders = await SignedOrder.find({
      seller: user.walletAddress.toLowerCase(),
      status: "Active",
      kind: { $ne: "follow" },
      marketplace: { $ne: chain.addresses.TokenMarketplace.toLowerCase() },
    }).sort({ createdAt: -1 }).lean();

    const data = [];
    for (const o of orders) {
      if (o.expiry && o.expiry <= now) continue;
      const [filled, cancelled, balance] = await Promise.all([
        old.orderFilled(o.orderHash).catch(() => null),
        old.orderCancelled(o.orderHash).catch(() => null),
        chain.assetToken.balanceOf(o.seller, o.assetId),
      ]);
      // The hash is not known to the earlier contract: it was not signed for it, so there is nothing to carry over.
      if (filled == null || cancelled) continue;
      let remaining = BigInt(o.amount) - filled;
      if (balance < remaining) remaining = balance;
      if (remaining <= 0n) continue;
      const assetDoc = await Asset.findOne({ $or: [{ blockchainAssetId: o.assetId }, { assetId: o.assetId }] });
      data.push({
        orderHash: o.orderHash,
        assetId: o.assetId,
        assetName: assetDoc?.name || assetDoc?.assetName || `Asset #${o.assetId}`,
        amount: Number(remaining),
        pricePerTokenBase: o.pricePerToken,
        pricePerTokenFormatted: Number(ethers.formatUnits(o.pricePerToken, 6)),
        expiry: o.expiry || 0,
      });
    }
    res.json({ success: true, count: data.length, data });
  } catch (err) {
    res.status(503).json({ success: false, message: "Unable to read your earlier offers", error: err.message });
  } finally {
    chain?.destroy();
  }
});

/**
 * POST /api/orders
 * Stores an order the seller signed. The signature must be the seller's, the seller must be the
 * signed-in user's linked wallet, and the order must be for a tokenized asset in the platform's payment token.
 */
router.post("/", protect, async (req, res) => {
  let chain;
  try {
    const { order, signature } = req.body || {};
    if (!order || !signature) return res.status(400).json({ success: false, message: "order and signature are required" });

    const follows = order.premiumBps !== undefined;
    const amount = BigInt(order.amount);
    const price = follows ? 0n : BigInt(order.pricePerToken);
    if (amount <= 0n || (!follows && price <= 0n)) return res.status(400).json({ success: false, message: "Amount and price must be above zero" });

    chain = loadChain();
    const common = {
      seller: order.seller,
      assetId: BigInt(order.assetId),
      amount,
      paymentToken: order.paymentToken,
      expiry: BigInt(order.expiry || 0),
      salt: BigInt(order.salt),
    };
    let typed;
    if (follows) {
      const premium = BigInt(order.premiumBps);
      if (premium < -5000n || premium > 10000n) return res.status(400).json({ success: false, message: "Premium must be between -50% and +100%" });
      typed = {
        seller: common.seller, assetId: common.assetId, amount, premiumBps: premium,
        floorPrice: BigInt(order.floorPrice || 0), paymentToken: common.paymentToken, expiry: common.expiry, salt: common.salt,
      };
    } else {
      typed = { ...common, pricePerToken: price };
    }
    const recovered = ethers.verifyTypedData(marketplaceDomain(chain), follows ? FOLLOW_ORDER_TYPES : ORDER_TYPES, typed, signature);
    if (!sameAddress(recovered, order.seller)) {
      return res.status(400).json({ success: false, message: "The signature does not match the seller" });
    }

    const user = await User.findById(req.user.userId);
    if (!user?.walletAddress || !sameAddress(user.walletAddress, order.seller)) {
      return res.status(403).json({ success: false, message: "You can only sign orders from the wallet linked to your account" });
    }
    if (!sameAddress(order.paymentToken, chain.addresses.MockPaymentToken)) {
      return res.status(400).json({ success: false, message: "Unsupported payment token" });
    }
    if (!(await chain.assetToken.isTokenized(typed.assetId))) {
      return res.status(400).json({ success: false, message: "Asset is not tokenized" });
    }

    const orderHash = follows ? await chain.marketplace.hashFollowOrder(typed) : await chain.marketplace.hashOrder(typed);
    const saved = await SignedOrder.findOneAndUpdate(
      { orderHash },
      {
        orderHash,
        seller: order.seller.toLowerCase(),
        assetId: Number(order.assetId),
        amount: Number(amount),
        kind: follows ? "follow" : "fixed",
        premiumBps: follows ? Number(typed.premiumBps) : 0,
        floorPrice: follows ? typed.floorPrice.toString() : "0",
        marketplace: chain.addresses.TokenMarketplace.toLowerCase(),
        pricePerToken: price.toString(),
        paymentToken: order.paymentToken,
        expiry: Number(order.expiry || 0),
        salt: String(order.salt),
        signature,
        status: "Active",
      },
      { upsert: true, new: true }
    );
    res.status(201).json({ success: true, data: { orderHash: saved.orderHash } });
  } catch (err) {
    res.status(400).json({ success: false, message: err.shortMessage || err.message });
  } finally {
    chain?.destroy();
  }
});

/**
 * POST /api/orders/:orderHash/cancel
 * Hides the order from the book. The seller also cancels it on-chain so the signature is dead everywhere.
 */
router.post("/:orderHash/cancel", protect, async (req, res) => {
  try {
    const order = await SignedOrder.findOne({ orderHash: req.params.orderHash });
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });
    const user = await User.findById(req.user.userId);
    if (user?.role !== "admin" && !sameAddress(user?.walletAddress, order.seller)) {
      return res.status(403).json({ success: false, message: "Only the seller can cancel this order" });
    }
    order.status = "Cancelled";
    await order.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
