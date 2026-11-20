import express from "express";
import { ethers } from "ethers";
import { Asset } from "../models/Asset.js";
import User from "../models/User.js";
import { SaleVote } from "../models/SaleVote.js";
import { SalePayout } from "../models/SalePayout.js";
import { protect, authorize } from "../middleware/auth.js";
import { requireDatabase } from "../middleware/requireDatabase.js";
import { loadChain, VOTE_TYPES, saleDomain } from "../services/chainContracts.js";
import { hashLeaf, MerkleTreeEngine } from "../services/MerkleDistributionService.js";
import gasAnalyticsService from "../services/GasAnalyticsService.js";

const router = express.Router();
router.use(requireDatabase);

const STATUS = ["None", "Pending", "Voting", "Approved", "Rejected", "Settled", "Cancelled"];
const RELAY_BATCH = 100;

const sameAddress = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
const wrap = (handler) => async (req, res) => {
  let chain;
  try {
    chain = loadChain({ withSigner: handler.admin === true });
    await handler(req, res, chain);
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.shortMessage || err.reason || err.message });
  } finally {
    chain?.destroy();
  }
};
const fail = (status, message) => Object.assign(new Error(message), { status });

async function describeOffer(chain, offer) {
  const assetId = Number(offer.assetId);
  const assetDoc = await Asset.findOne({ $or: [{ blockchainAssetId: assetId }, { assetId }] });
  const totalShares = Number(await chain.assetToken.totalShares(assetId));
  const [pendingVotes, pendingYes] = await Promise.all([
    SaleVote.countDocuments({ offerId: Number(offer.offerId), relayed: false }),
    SaleVote.countDocuments({ offerId: Number(offer.offerId), relayed: false, support: 1 }),
  ]);
  return {
    offerId: Number(offer.offerId),
    assetId,
    assetName: assetDoc?.name || assetDoc?.assetName || `Asset #${assetId}`,
    location: assetDoc?.location || "",
    buyer: offer.buyer,
    price: Number(ethers.formatUnits(offer.price, 6)),
    priceBase: offer.price.toString(),
    status: Number(offer.status),
    statusLabel: STATUS[Number(offer.status)],
    votingEndsAt: Number(offer.votingEndsAt),
    votingDuration: Number(offer.votingDuration),
    snapshotId: Number(offer.snapshotId),
    yesVotes: Number(offer.yesVotes),
    noVotes: Number(offer.noVotes),
    totalShares,
    claimedAmount: Number(ethers.formatUnits(offer.claimedAmount, 6)),
    pendingSignedVotes: pendingVotes,
    pendingSignedYes: pendingYes,
  };
}

/** GET /api/sales: every property sale offer on the chain. */
router.get("/", wrap(async (req, res, chain) => {
  const next = Number(await chain.sale.nextOfferId());
  const data = [];
  for (let id = 1; id < next; id++) {
    data.push(await describeOffer(chain, await chain.sale.getOffer(id)));
  }
  res.json({ success: true, count: data.length, data: data.reverse() });
}));

/** GET /api/sales/:offerId?address= : one offer, plus what the given wallet can do on it. */
router.get("/:offerId", wrap(async (req, res, chain) => {
  const offerId = Number(req.params.offerId);
  const offer = await chain.sale.getOffer(offerId).catch(() => null);
  if (!offer) throw fail(404, "Offer not found");
  const data = await describeOffer(chain, offer);

  const address = req.query.address;
  let viewer = null;
  if (address && ethers.isAddress(address)) {
    const [hasVoted, pending, payout, weight] = await Promise.all([
      chain.sale.hasVoted(offerId, address),
      SaleVote.findOne({ offerId, voter: address.toLowerCase() }).lean(),
      SalePayout.findOne({ offerId, claimant: address.toLowerCase() }).lean(),
      Number(offer.snapshotId) > 0 ? chain.assetToken.balanceOfAtSnapshot(address, offer.assetId, offer.snapshotId) : 0n,
    ]);
    const hasClaimed = payout ? await chain.sale.hasClaimed(offerId, address) : false;
    viewer = {
      votingWeight: Number(weight),
      hasVotedOnChain: hasVoted,
      signedVote: pending ? { support: pending.support, relayed: pending.relayed } : null,
      payout: payout ? { amount: Number(ethers.formatUnits(payout.amount, 6)), claimed: hasClaimed } : null,
    };
  }
  res.json({ success: true, data, viewer });
}));

/** GET /api/sales/:offerId/payout/:address : the amount and Merkle proof a holder uses to claim. */
router.get("/:offerId/payout/:address", async (req, res) => {
  const row = await SalePayout.findOne({
    offerId: Number(req.params.offerId),
    claimant: String(req.params.address).toLowerCase(),
  }).lean();
  if (!row) return res.status(404).json({ success: false, message: "No payout for this wallet" });
  res.json({ success: true, data: { amount: row.amount, proof: row.proof } });
});

/**
 * POST /api/sales/:offerId/votes
 * Stores a vote the holder signed off-chain. The platform submits all pending votes in one transaction,
 * so the holder pays no gas.
 */
router.post("/:offerId/votes", protect, wrap(async (req, res, chain) => {
  const offerId = Number(req.params.offerId);
  const support = Number(req.body?.support);
  const signature = req.body?.signature;
  if (![1, 2].includes(support) || !signature) throw fail(400, "support (1 or 2) and signature are required");

  const offer = await chain.sale.getOffer(offerId).catch(() => null);
  if (!offer) throw fail(404, "Offer not found");
  if (Number(offer.status) !== 2) throw fail(400, "Voting is not open for this offer");
  if (Number(offer.votingEndsAt) < Math.floor(Date.now() / 1000)) throw fail(400, "The voting period has ended");

  const voter = ethers.verifyTypedData(saleDomain(chain), VOTE_TYPES, { offerId, support }, signature);
  const user = await User.findById(req.user.userId);
  if (!user?.walletAddress || !sameAddress(user.walletAddress, voter)) {
    throw fail(403, "Sign the vote with the wallet linked to your account");
  }
  if (await chain.sale.hasVoted(offerId, voter)) throw fail(400, "This wallet has already voted");
  const weight = await chain.assetToken.balanceOfAtSnapshot(voter, offer.assetId, offer.snapshotId);
  if (weight === 0n) throw fail(400, "This wallet held no tokens when voting opened");

  if (await SaleVote.exists({ offerId, voter: voter.toLowerCase() })) {
    throw fail(400, "You have already signed a vote for this offer");
  }
  try {
    await SaleVote.create({ offerId, voter: voter.toLowerCase(), support, signature });
  } catch (err) {
    if (err.code === 11000) throw fail(400, "You have already signed a vote for this offer");
    throw err;
  }
  res.status(201).json({ success: true, message: "Vote recorded. The platform will submit it for you with no gas cost to you." });
}));

// ---------------------------------------------------------------- admin actions

const adminOnly = [protect, authorize("admin")];

const adminAction = (fn) => {
  const handler = async (req, res, chain) => fn(req, res, chain);
  handler.admin = true;
  return wrap(handler);
};

router.post("/:offerId/open", ...adminOnly, adminAction(async (req, res, chain) => {
  const offerId = Number(req.params.offerId);
  const receipt = await (await chain.sale.openVoting(offerId)).wait();
  const offer = await chain.sale.getOffer(offerId);
  await gasAnalyticsService.recordPlatformReceipt(receipt, "SaleAdmin", { assetId: Number(offer.assetId) });
  res.json({ success: true, txHash: receipt.hash });
}));

router.post("/:offerId/relay-votes", ...adminOnly, adminAction(async (req, res, chain) => {
  const offerId = Number(req.params.offerId);
  const offer = await chain.sale.getOffer(offerId);
  const pending = await SaleVote.find({ offerId, relayed: false }).sort({ createdAt: 1 });
  if (!pending.length) return res.json({ success: true, relayed: 0, counted: 0, message: "No pending signed votes" });

  let counted = 0;
  let gasUsed = 0n;
  const txHashes = [];
  for (let i = 0; i < pending.length; i += RELAY_BATCH) {
    const batch = pending.slice(i, i + RELAY_BATCH);
    const supports = batch.map((v) => v.support);
    const signatures = batch.map((v) => v.signature);
    counted += Number(await chain.sale.castVotesBySig.staticCall(offerId, supports, signatures));
    const receipt = await (await chain.sale.castVotesBySig(offerId, supports, signatures)).wait();
    await gasAnalyticsService.recordPlatformReceipt(receipt, "SaleVoteRelay", { assetId: Number(offer.assetId) });
    await SaleVote.updateMany({ _id: { $in: batch.map((v) => v._id) } }, { relayed: true, relayTxHash: receipt.hash });
    gasUsed += receipt.gasUsed;
    txHashes.push(receipt.hash);
  }
  res.json({ success: true, relayed: pending.length, counted, gasUsed: gasUsed.toString(), txHashes });
}));

router.post("/:offerId/finalize", ...adminOnly, adminAction(async (req, res, chain) => {
  const offerId = Number(req.params.offerId);
  const offer = await chain.sale.getOffer(offerId);
  const receipt = await (await chain.sale.finalize(offerId)).wait();
  await gasAnalyticsService.recordPlatformReceipt(receipt, "SaleAdmin", { assetId: Number(offer.assetId) });
  const after = await chain.sale.getOffer(offerId);
  res.json({ success: true, txHash: receipt.hash, status: STATUS[Number(after.status)] });
}));

/**
 * Confirms the legal transfer. Builds every holder's payout from the vote snapshot
 * (price x balance / total supply; the rounding remainder goes to the largest holder so the
 * payouts add up to the price exactly), publishes the Merkle root, and stores each holder's proof.
 */
router.post("/:offerId/confirm", ...adminOnly, adminAction(async (req, res, chain) => {
  const offerId = Number(req.params.offerId);
  const offer = await chain.sale.getOffer(offerId);
  if (Number(offer.status) !== 3) throw fail(400, "Only an approved offer can be confirmed");

  const assetId = offer.assetId;
  const logs = await chain.assetToken.queryFilter(chain.assetToken.filters.TransferSingle(), 0);
  const candidates = new Set();
  for (const log of logs) {
    if (log.args.id === assetId && log.args.to !== ethers.ZeroAddress) candidates.add(log.args.to);
  }

  const supply = await chain.assetToken.totalShares(assetId);
  const holders = [];
  for (const address of candidates) {
    const balance = await chain.assetToken.balanceOfAtSnapshot(address, assetId, offer.snapshotId);
    if (balance > 0n) holders.push({ address, balance });
  }
  if (!holders.length) throw fail(400, "No token holders found at the snapshot");
  holders.sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));

  const payouts = holders.map((h) => (offer.price * h.balance) / supply);
  const distributed = payouts.reduce((a, b) => a + b, 0n);
  payouts[0] += offer.price - distributed; // rounding remainder to the largest holder

  const leaves = holders.map((h, i) =>
    hashLeaf(chain.chainId, chain.addresses.PropertySale, assetId, offerId, h.address, payouts[i])
  );
  const tree = new MerkleTreeEngine(leaves);

  const receipt = await (await chain.sale.confirmSale(offerId, tree.getRoot())).wait();
  await gasAnalyticsService.recordPlatformReceipt(receipt, "SaleAdmin", { assetId: Number(assetId) });

  await SalePayout.deleteMany({ offerId });
  await SalePayout.insertMany(
    holders.map((h, i) => ({
      offerId,
      claimant: h.address.toLowerCase(),
      amount: payouts[i].toString(),
      proof: tree.getProof(i),
    }))
  );
  res.json({ success: true, txHash: receipt.hash, holders: holders.length, merkleRoot: tree.getRoot() });
}));

router.post("/:offerId/cancel", ...adminOnly, adminAction(async (req, res, chain) => {
  const offerId = Number(req.params.offerId);
  const offer = await chain.sale.getOffer(offerId);
  const receipt = await (await chain.sale.cancelOffer(offerId)).wait();
  await gasAnalyticsService.recordPlatformReceipt(receipt, "SaleAdmin", { assetId: Number(offer.assetId) });
  res.json({ success: true, txHash: receipt.hash });
}));

export default router;
