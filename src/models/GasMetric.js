import mongoose from "mongoose";
import { isDbConnected } from "../config/db.js";

const gasMetricSchema = new mongoose.Schema(
  {
    txHash: { type: String, required: true, unique: true, index: true },
    blockNumber: { type: Number, required: true, index: true },
    operationType: {
      type: String,
      required: true,
      enum: [
        "AssetTokenization",
        "MarketplaceListing",
        "MarketplacePurchase",
        "DirectTransfer",
        "DistributionPublish",
        "DistributionFunding",
        "ProfitClaim",
        "BaselineSnapshotPayout",
        "AdminOperation"
      ],
      index: true
    },
    gasUsed: { type: Number, required: true },
    effectiveGasPriceGwei: { type: Number, required: true },
    totalFeeWei: { type: String, required: true },
    totalFeeEth: { type: Number, required: true },
    payerAddress: { type: String, required: true, lowercase: true },
    payerCategory: { type: String, enum: ["Platform", "Investor"], default: "Investor" },
    assetId: { type: Number },
    roundId: { type: Number },
    timestamp: { type: Date, default: Date.now, index: true }
  },
  { timestamps: true }
);

const MongoGasMetric = mongoose.models.GasMetric || mongoose.model("GasMetric", gasMetricSchema);

const inMemoryGas = [];

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

const GasMetric = {
  async create(metricData) {
    if (isDbConnected()) {
      return MongoGasMetric.create(metricData);
    }
    const exists = inMemoryGas.some((g) => g.txHash === metricData.txHash);
    if (!exists) {
      const record = { ...metricData, _id: String(Date.now() + Math.random()), createdAt: new Date() };
      inMemoryGas.push(record);
      return record;
    }
    return null;
  },

  async find(filter = {}) {
    if (isDbConnected()) {
      return MongoGasMetric.find(filter).sort({ timestamp: -1 }).lean();
    }
    return inMemoryGas.filter((g) => matchesFilter(g, filter)).sort((a, b) => b.timestamp - a.timestamp);
  },

  async countDocuments(filter = {}) {
    if (isDbConnected()) {
      return MongoGasMetric.countDocuments(filter);
    }
    return inMemoryGas.filter((g) => matchesFilter(g, filter)).length;
  }
};

export default GasMetric;
