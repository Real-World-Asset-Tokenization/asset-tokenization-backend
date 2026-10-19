import mongoose from "mongoose";
import { isDbConnected } from "../config/db.js";

const distributionRoundSchema = new mongoose.Schema(
  {
    roundId: { type: Number, required: true, unique: true, index: true },
    assetId: { type: Number, required: true, index: true },
    periodLabel: { type: String, required: true },
    merkleRoot: { type: String, required: true },
    totalPayout: { type: Number, required: true }, // in payment token base units
    totalPayoutFormatted: { type: Number, required: true }, // in mUSD decimal units
    fundedAmount: { type: Number, default: 0 },
    claimedAmount: { type: Number, default: 0 },
    paymentTokenAddress: { type: String, required: true },
    reportHash: { type: String, required: true },
    txHashPublish: { type: String },
    txHashFunding: { type: String },
    status: {
      type: String,
      enum: ["Draft", "Approved", "Funded", "Active", "Closed"],
      default: "Approved"
    },
    eligibleHoldersCount: { type: Number, default: 0 },
    totalEligibleTokenSeconds: { type: Number, default: 0 }
  },
  { timestamps: true }
);

const MongoDistributionRound = mongoose.models.DistributionRound || mongoose.model("DistributionRound", distributionRoundSchema);

const inMemoryRounds = [];

const matchesFilter = (item, filter) => {
  for (const key of Object.keys(filter)) {
    if (typeof filter[key] === "object" && filter[key] !== null) {
      if (filter[key].$gte !== undefined && item[key] < filter[key].$gte) return false;
      if (filter[key].$lte !== undefined && item[key] > filter[key].$lte) return false;
      if (filter[key].$in !== undefined && !filter[key].$in.includes(item[key])) return false;
    } else {
      if (String(item[key]).toLowerCase() !== String(filter[key]).toLowerCase()) return false;
    }
  }
  return true;
};

const DistributionRound = {
  async create(roundData) {
    if (isDbConnected()) {
      return MongoDistributionRound.create(roundData);
    }
    const record = { ...roundData, _id: String(Date.now() + Math.random()), createdAt: new Date() };
    inMemoryRounds.push(record);
    return record;
  },

  async find(filter = {}) {
    if (isDbConnected()) {
      return MongoDistributionRound.find(filter).sort({ roundId: -1 }).lean();
    }
    return inMemoryRounds.filter((r) => matchesFilter(r, filter)).sort((a, b) => b.roundId - a.roundId);
  },

  async findOne(filter = {}) {
    if (isDbConnected()) {
      return MongoDistributionRound.findOne(filter).lean();
    }
    return inMemoryRounds.find((r) => matchesFilter(r, filter)) || null;
  },

  async updateOne(filter, update) {
    const updates = update.$set || update;
    if (isDbConnected()) {
      return MongoDistributionRound.updateOne(filter, update);
    }
    const round = inMemoryRounds.find((r) => matchesFilter(r, filter));
    if (round) {
      Object.assign(round, updates, { updatedAt: new Date() });
      return { acknowledged: true, modifiedCount: 1 };
    }
    return { acknowledged: true, modifiedCount: 0 };
  }
};

export default DistributionRound;
