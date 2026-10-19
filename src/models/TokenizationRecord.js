import mongoose from "mongoose";
import { isDbConnected } from "../config/db.js";

const tokenizationRecordSchema = new mongoose.Schema(
  {
    assetId: {
      type: Number,
      required: true,
      unique: true,
      index: true,
    },
    assetName: {
      type: String,
      required: true,
      trim: true,
    },
    assetSymbol: {
      type: String,
      default: "RWA",
    },
    ownerWallet: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    approvedValuation: {
      type: Number,
      required: true,
      min: 0,
    },
    valuationCurrency: {
      type: String,
      default: "LKR",
      uppercase: true,
    },
    valuationDate: {
      type: Date,
      default: Date.now,
    },
    approvedTokenSupply: {
      type: Number,
      required: true,
      min: 1,
    },
    calculatedReferencePrice: {
      type: Number,
      required: true,
      min: 0,
    },
    tokenizationStatus: {
      type: String,
      enum: [
        "VERIFIED",
        "TOKENIZATION_REQUESTED",
        "MINTING_PENDING",
        "TOKENIZED",
        "FAILED",
        "REJECTED",
      ],
      default: "VERIFIED",
      index: true,
    },
    chainId: {
      type: Number,
      default: 31337,
    },
    contractAddress: {
      type: String,
      default: "",
    },
    tokenId: {
      type: Number,
      default: 1,
    },
    mintingTxHash: {
      type: String,
      default: "",
    },
    confirmedBlockNumber: {
      type: Number,
      default: 0,
    },
    approvedMetadataHash: {
      type: String,
      default: "",
    },
    gasUsed: {
      type: Number,
      default: 0,
    },
    effectiveGasPrice: {
      type: String,
      default: "",
    },
    historicalValuations: [
      {
        valuation: Number,
        referencePrice: Number,
        effectiveDate: { type: Date, default: Date.now },
        approvalRef: String,
        updatedBy: String,
      },
    ],
  },
  {
    timestamps: true,
  }
);

// Mongoose model
const MongooseTokenizationRecord = mongoose.model(
  "TokenizationRecord",
  tokenizationRecordSchema
);

// Resilient in-memory store for fallback when Azure Cosmos DB is offline / disconnected
const inMemoryRecords = new Map();

export class TokenizationRecord {
  static async findOne(query) {
    if (isDbConnected()) {
      return await MongooseTokenizationRecord.findOne(query);
    }
    for (const record of inMemoryRecords.values()) {
      let match = true;
      for (const [k, v] of Object.entries(query)) {
        if (typeof v === "object" && v !== null) {
          // simple match
        } else if (record[k] !== v) {
          match = false;
          break;
        }
      }
      if (match) return record;
    }
    return null;
  }

  static async find(query = {}) {
    if (isDbConnected()) {
      return await MongooseTokenizationRecord.find(query).sort({ createdAt: -1 });
    }
    let results = Array.from(inMemoryRecords.values());
    if (query.ownerWallet) {
      results = results.filter(
        (r) =>
          r.ownerWallet &&
          r.ownerWallet.toLowerCase() === query.ownerWallet.toLowerCase()
      );
    }
    if (query.tokenizationStatus) {
      results = results.filter((r) => r.tokenizationStatus === query.tokenizationStatus);
    }
    return results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  static async create(data) {
    if (isDbConnected()) {
      return await MongooseTokenizationRecord.create(data);
    }
    const newRecord = {
      ...data,
      _id: `mem_tok_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      historicalValuations: data.historicalValuations || [],
    };
    inMemoryRecords.set(newRecord.assetId, newRecord);
    return newRecord;
  }

  static async findOneAndUpdate(query, update, options = { new: true, upsert: false }) {
    if (isDbConnected()) {
      return await MongooseTokenizationRecord.findOneAndUpdate(query, update, options);
    }
    const record = await this.findOne(query);
    if (!record && !options.upsert) return null;

    const updated = {
      ...(record || { assetId: query.assetId, createdAt: new Date().toISOString() }),
      ...(update.$set || update),
      updatedAt: new Date().toISOString(),
    };
    if (update.$push && update.$push.historicalValuations) {
      updated.historicalValuations = updated.historicalValuations || [];
      updated.historicalValuations.push(update.$push.historicalValuations);
    }
    inMemoryRecords.set(updated.assetId, updated);
    return updated;
  }
}

export default TokenizationRecord;
