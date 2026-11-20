import mongoose from "mongoose";
import { isDbConnected } from "../config/db.js";

const investorAllocationSchema = new mongoose.Schema(
  {
    roundId: { type: Number, required: true, index: true },
    assetId: { type: Number, required: true, index: true },
    walletAddress: { type: String, required: true, lowercase: true, index: true },
    openingBalance: { type: Number, default: 0 },
    closingBalance: { type: Number, default: 0 },
    tokenSeconds: { type: Number, required: true },
    weightFraction: { type: Number, required: true }, // e.g. 0.15 = 15%
    payoutUnits: { type: String, required: true },    // integer base units string
    payoutAmountFormatted: { type: Number, required: true }, // human readable number
    merkleProof: [{ type: String }],
    leafHash: { type: String, required: true },
    leafIndex: { type: Number, required: true },
    isClaimed: { type: Boolean, default: false, index: true },
    claimedAt: { type: Date },
    txHashClaim: { type: String }
  },
  { timestamps: true }
);

investorAllocationSchema.index({ roundId: 1, walletAddress: 1 }, { unique: true });

const MongoInvestorAllocation = mongoose.models.InvestorAllocation || mongoose.model("InvestorAllocation", investorAllocationSchema);

const inMemoryAllocations = [];

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

const InvestorAllocation = {
  async insertMany(allocations) {
    if (isDbConnected()) {
      return MongoInvestorAllocation.insertMany(allocations);
    }
    const inserted = allocations.map((a) => ({
      ...a,
      _id: String(Date.now() + Math.random()),
      createdAt: new Date()
    }));
    inMemoryAllocations.push(...inserted);
    return inserted;
  },

  async find(filter = {}) {
    if (isDbConnected()) {
      return MongoInvestorAllocation.find(filter).lean();
    }
    return inMemoryAllocations.filter((a) => matchesFilter(a, filter));
  },

  async findOne(filter = {}) {
    if (isDbConnected()) {
      return MongoInvestorAllocation.findOne(filter).lean();
    }
    return inMemoryAllocations.find((a) => matchesFilter(a, filter)) || null;
  },

  async updateOne(filter, update) {
    const updates = update.$set || update;
    if (isDbConnected()) {
      return MongoInvestorAllocation.updateOne(filter, update);
    }
    const alloc = inMemoryAllocations.find((a) => matchesFilter(a, filter));
    if (alloc) {
      Object.assign(alloc, updates, { updatedAt: new Date() });
      return { acknowledged: true, modifiedCount: 1 };
    }
    return { acknowledged: true, modifiedCount: 0 };
  }
};

export default InvestorAllocation;
