import mongoose from "mongoose";
import { isDbConnected } from "../config/db.js";

const ownershipEventSchema = new mongoose.Schema(
  {
    network: { type: String, default: "localhost" },
    chainId: { type: Number, required: true, index: true },
    contractAddress: { type: String, required: true, lowercase: true, index: true },
    assetId: { type: Number, required: true, index: true },
    fromAddress: { type: String, required: true, lowercase: true, index: true },
    toAddress: { type: String, required: true, lowercase: true, index: true },
    amount: { type: Number, required: true },
    txHash: { type: String, required: true, index: true },
    blockNumber: { type: Number, required: true, index: true },
    blockTimestamp: { type: Number, required: true, index: true },
    logIndex: { type: Number, required: true },
    eventType: { type: String, required: true, enum: ["TransferSingle", "TransferBatch", "Mint", "Burn"] }
  },
  { timestamps: true }
);

ownershipEventSchema.index({ chainId: 1, txHash: 1, logIndex: 1 }, { unique: true });
ownershipEventSchema.index({ assetId: 1, blockTimestamp: 1 });

const MongoOwnershipEvent = mongoose.models.OwnershipEvent || mongoose.model("OwnershipEvent", ownershipEventSchema);

const inMemoryEvents = [];

const matchesFilter = (item, filter) => {
  for (const key of Object.keys(filter)) {
    if (typeof filter[key] === "object" && filter[key] !== null) {
      if (filter[key].$gte !== undefined && item[key] < filter[key].$gte) return false;
      if (filter[key].$lte !== undefined && item[key] > filter[key].$lte) return false;
      if (filter[key].$gt !== undefined && item[key] <= filter[key].$gt) return false;
      if (filter[key].$lt !== undefined && item[key] >= filter[key].$lt) return false;
      if (filter[key].$in !== undefined && !filter[key].$in.includes(item[key])) return false;
    } else {
      if (String(item[key]).toLowerCase() !== String(filter[key]).toLowerCase()) return false;
    }
  }
  return true;
};

const OwnershipEvent = {
  async create(eventData) {
    if (isDbConnected()) {
      try {
        return await MongoOwnershipEvent.create(eventData);
      } catch (err) {
        if (err.code === 11000 || String(err.message).includes("Duplicate key")) {
          return null;
        }
        throw err;
      }
    }
    const exists = inMemoryEvents.some(
      (e) =>
        e.chainId === eventData.chainId &&
        e.txHash === eventData.txHash &&
        e.logIndex === eventData.logIndex
    );
    if (!exists) {
      const record = { ...eventData, _id: String(Date.now() + Math.random()), createdAt: new Date() };
      inMemoryEvents.push(record);
      return record;
    }
    return null;
  },

  async find(filter = {}) {
    if (isDbConnected()) {
      return MongoOwnershipEvent.find(filter).sort({ blockTimestamp: 1, logIndex: 1 }).lean();
    }
    return inMemoryEvents
      .filter((e) => matchesFilter(e, filter))
      .sort((a, b) => a.blockTimestamp - b.blockTimestamp || a.logIndex - b.logIndex);
  },

  async findOne(filter = {}) {
    if (isDbConnected()) {
      return MongoOwnershipEvent.findOne(filter).lean();
    }
    return inMemoryEvents.find((e) => matchesFilter(e, filter)) || null;
  },

  async countDocuments(filter = {}) {
    if (isDbConnected()) {
      return MongoOwnershipEvent.countDocuments(filter);
    }
    return inMemoryEvents.filter((e) => matchesFilter(e, filter)).length;
  }
};

export default OwnershipEvent;
