import mongoose from "mongoose";
import { isDbConnected } from "../config/db.js";

const assetSchema = new mongoose.Schema({
  // ==========================================
  // 1. ASSET IDENTIFICATION & OWNERSHIP
  // ==========================================
  assetId: {
    type: Number,
    required: true,
    unique: true,
    index: true,
  },

  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: false,
    index: true,
  },

  issuerWallet: {
    type: String,
    required: true,
    index: true,
  },

  // ==========================================
  // 2. ASSET INFORMATION
  // ==========================================
  name: {
    type: String,
    required: true,
    trim: true,
  },

  // Supports the original blockchain model
  assetName: {
    type: String,
    trim: true,
  },

  symbol: {
    type: String,
    required: true,
    trim: true,
  },

  propertyType: {
    type: String,
    default: "Residential Real Estate",
  },

  assetType: {
    type: String,
    enum: [
      "real_estate",
      "vehicle",
      "equipment",
      "intellectual_property",
      "other",
    ],
    default: "real_estate",
  },

  location: {
    type: String,
    required: true,
  },

  description: {
    type: String,
    default: "",
  },

  // ==========================================
  // 3. VALUATION & TOKENIZATION
  // ==========================================
  valuationLKR: {
    type: Number,
    required: true,
    min: 0,
  },

  // Supports the verification model's valuation field
  valuation: {
    type: Number,
    min: 0,
  },

  currency: {
    type: String,
    default: "LKR",
    uppercase: true,
  },

  totalShares: {
    type: Number,
    required: true,
    min: 1,
  },

  sharePriceLKR: {
    type: Number,
    required: true,
    min: 0,
  },

  // ==========================================
  // 4. BLOCKCHAIN & METADATA
  // ==========================================
  metadataURI: {
    type: String,
    required: true,
  },

  documentHash: {
    type: String,
    required: true,
    index: true,
  },

  imageUrl: {
    type: String,
    default: "",
  },

  txHash: {
    type: String,
    default: "",
  },

  status: {
    type: String,
    enum: ["Pending", "Approved", "Tokenized", "Rejected"],
    default: "Pending",
    index: true,
  },

  tokenizedAt: {
    type: Date,
  },

  // ==========================================
  // BLOCKCHAIN INTEGRATION FIELDS
  // ==========================================
  blockchainAssetId: {
    type: Number,
    default: null,
  },

  // ==========================================
  // 5. DOCUMENT UPLOADS
  // ==========================================

  // Legacy single-document support
  document: {
    type: String,
  },

  documentPublicId: {
    type: String,
  },

  // Multiple document types
  documents: {
    deed: {
      url: String,
      publicId: String,
    },
    surveyPlan: {
      url: String,
      publicId: String,
    },
    extracts: {
      url: String,
      publicId: String,
    },
    priorDeeds: {
      url: String,
      publicId: String,
    },
    certificates: {
      url: String,
      publicId: String,
    },
  },

  // ==========================================
  // 6. OCR-EXTRACTED INFORMATION
  // ==========================================
  ocrData: {
    ownerName: String,
    propertyNumber: String,
    registrationNumber: String,
    governmentAuthority: String,
    propertyAddress: String,
    marketValue: String,
    documentDate: String,
  },

  // ==========================================
  // 7. DOCUMENT & OWNERSHIP VERIFICATION
  // ==========================================
  verificationStatus: {
    type: String,
    enum: [
      "pending",
      "under_review",
      "approved",
      "rejected",
    ],
    default: "pending",
    index: true,
  },

  documentAuthentic: {
    type: Boolean,
    default: false,
  },

  ownershipVerified: {
    type: Boolean,
    default: false,
  },

  rejectionReason: {
    type: String,
    default: "",
  },

  verifiedAt: {
    type: Date,
  },

  // ==========================================
  // 8. AI DOCUMENT ANALYSIS
  // ==========================================
  aiGenerated: {
    type: Boolean,
    default: false,
  },

  manipulationDetected: {
    type: Boolean,
    default: false,
  },

  duplicateOf: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Asset",
    default: null,
  },

  clarityScore: {
    type: Number,
    min: 0,
    max: 100,
  },

  riskScore: {
    type: Number,
    min: 0,
    max: 100,
  },

  // ==========================================
  // 9. VERIFICATION PIPELINE RESULTS
  // ==========================================
  pipelineResults: {
    pipelineVersion: String,
    pipelineRunAt: Date,
    finalDecision: String,
    abortedAt: String,
    abortReason: String,

    stage1_clarity: mongoose.Schema.Types.Mixed,
    stage2_ai_generation: mongoose.Schema.Types.Mixed,
    stage3_manipulation: mongoose.Schema.Types.Mixed,
    stage4_hash: mongoose.Schema.Types.Mixed,
    stage5_ocr: mongoose.Schema.Types.Mixed,
    stage6_risk: mongoose.Schema.Types.Mixed,
  },

  // ==========================================
  // 10. TIMESTAMPS
  // ==========================================
  createdAt: {
    type: Date,
    default: Date.now,
  },

}, {
  timestamps: false,
  strict: true,
});

// ==========================================
// MONGOOSE MODEL
// ==========================================
const MongoAsset =
  mongoose.models.Asset ||
  mongoose.model("Asset", assetSchema);

// ==========================================
// IN-MEMORY SEED DATA
// ==========================================
const inMemoryAssets = [
  {
    assetId: 1,
    ownerId: undefined,
    name: "Colombo Oceanfront Residence",
    assetName: "Colombo Oceanfront Residence",
    symbol: "COR-01",
    propertyType: "Luxury Residential Penthouse",
    assetType: "real_estate",
    location: "Kollupitiya, Marine Drive, Colombo 03, Sri Lanka",
    description:
      "Premium three-bedroom ocean-facing luxury penthouse.",
    valuationLKR: 10000000,
    valuation: 10000000,
    currency: "LKR",
    totalShares: 1000,
    sharePriceLKR: 10000,
    metadataURI:
      "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/colombo-apartment.json",
    documentHash:
      "0x9f83c6138438914b1bf0597bc5f8f5339f40feef2c95e5d326f9661d9a5b6d92",
    imageUrl:
      "https://images.unsplash.com/photo-1545324418-cc1a3fa10c00?auto=format&fit=crop&w=1200&q=80",
    issuerWallet:
      "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    status: "Tokenized",
    txHash:
      "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    verificationStatus: "approved",
    documentAuthentic: true,
    ownershipVerified: true,
    aiGenerated: false,
    manipulationDetected: false,
    createdAt: new Date(),
    tokenizedAt: new Date(),
    verifiedAt: new Date(),
  },
  {
    assetId: 2,
    ownerId: undefined,
    name: "Kandy Royal Commercial Plaza",
    assetName: "Kandy Royal Commercial Plaza",
    symbol: "KRP-02",
    propertyType: "Commercial Retail & Office Plaza",
    assetType: "real_estate",
    location: "Dalada Veediya, Kandy City Center, Sri Lanka",
    description:
      "Commercial retail and office plaza near Kandy Lake.",
    valuationLKR: 50000000,
    valuation: 50000000,
    currency: "LKR",
    totalShares: 5000,
    sharePriceLKR: 10000,
    metadataURI:
      "ipfs://bafybeihkoviema7g3gx4e2lrtqfop4x42m66x4o2j2v65p3zldu54nhe2y/kandy-plaza.json",
    documentHash:
      "0x7c2d5e3f4b6a9c1e2d3b4a5c6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f",
    imageUrl:
      "https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?auto=format&fit=crop&w=1200&q=80",
    issuerWallet:
      "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    status: "Pending",
    txHash: "",
    verificationStatus: "pending",
    documentAuthentic: false,
    ownershipVerified: false,
    aiGenerated: false,
    manipulationDetected: false,
    createdAt: new Date(),
  },
  {
    assetId: 3,
    ownerId: undefined,
    name: "Galle Dutch Fort Heritage Villa",
    assetName: "Galle Dutch Fort Heritage Villa",
    symbol: "GFV-03",
    propertyType: "Hospitality & Heritage Villa",
    assetType: "real_estate",
    location:
      "Leyn Baan Street, Galle Fort, Southern Province, Sri Lanka",
    description:
      "Restored heritage villa within Galle Fort.",
    valuationLKR: 25000000,
    valuation: 25000000,
    currency: "LKR",
    totalShares: 2500,
    sharePriceLKR: 10000,
    metadataURI:
      "ipfs://bafybeicg4f3qpm5u3vx6z7h4h7q2x6o2q4f5o6z7a8b9c0d1e2f3a4b5c6/galle-villa.json",
    documentHash:
      "0x4a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b",
    imageUrl:
      "https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?auto=format&fit=crop&w=1200&q=80",
    issuerWallet:
      "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    status: "Pending",
    txHash: "",
    verificationStatus: "pending",
    documentAuthentic: false,
    ownershipVerified: false,
    aiGenerated: false,
    manipulationDetected: false,
    createdAt: new Date(),
  },
];

// ==========================================
// FALLBACK FILTER HELPERS
// ==========================================
function matchesFilter(item, filter = {}) {
  return Object.entries(filter).every(([key, value]) => {
    if (value === undefined || value === null) return true;

    // Support simple MongoDB-style equality queries
    if (key === "issuerWallet") {
      return (
        String(item.issuerWallet || "").toLowerCase() ===
        String(value).toLowerCase()
      );
    }

    if (key === "ownerId") {
      return String(item.ownerId || "") === String(value);
    }

    if (key === "assetId") {
      return Number(item.assetId) === Number(value);
    }

    return item[key] === value;
  });
}

// ==========================================
// UNIFIED ASSET DATA ACCESS
// ==========================================
export const Asset = {
  async find(filter = {}) {
    if (isDbConnected()) {
      return MongoAsset.find(filter).sort({ assetId: 1 });
    }

    return inMemoryAssets.filter((item) =>
      matchesFilter(item, filter)
    );
  },

  async findOne(query = {}) {
    if (isDbConnected()) {
      return MongoAsset.findOne(query);
    }

    return (
      inMemoryAssets.find((item) =>
        matchesFilter(item, query)
      ) || null
    );
  },

  async create(data) {
    const assetId =
      data.assetId ??
      (
        inMemoryAssets.length > 0
          ? Math.max(
              ...inMemoryAssets.map((item) => item.assetId)
            ) + 1
          : 1
      );

    const normalizedData = {
      ...data,
      assetId,
      name: data.name || data.assetName,
      assetName: data.assetName || data.name,
      valuationLKR: data.valuationLKR ?? data.valuation,
      valuation: data.valuation ?? data.valuationLKR,
      currency: data.currency || "LKR",
      createdAt: data.createdAt || new Date(),
    };

    if (isDbConnected()) {
      const doc = new MongoAsset(normalizedData);
      return doc.save();
    }

    const duplicate = inMemoryAssets.some(
      (item) => item.assetId === Number(assetId)
    );

    if (duplicate) {
      throw new Error(`Asset ID ${assetId} already exists`);
    }

    inMemoryAssets.push(normalizedData);
    return normalizedData;
  },

  async updateOne(query, update) {
    const updates = update.$set || update;

    if (isDbConnected()) {
      return MongoAsset.updateOne(query, update);
    }

    const asset = inMemoryAssets.find((item) =>
      matchesFilter(item, query)
    );

    if (!asset) {
      return {
        acknowledged: true,
        matchedCount: 0,
        modifiedCount: 0,
      };
    }

    Object.assign(asset, updates);

    return {
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 1,
    };
  },

  async findOneAndUpdate(query, update, options = { new: true }) {
    if (isDbConnected()) {
      return MongoAsset.findOneAndUpdate(query, update, options);
    }
    await this.updateOne(query, update);
    return this.findOne(query);
  },

  async countDocuments(filter = {}) {
    if (isDbConnected()) {
      return MongoAsset.countDocuments(filter);
    }

    return inMemoryAssets.filter((item) =>
      matchesFilter(item, filter)
    ).length;
  },
};

export default Asset;