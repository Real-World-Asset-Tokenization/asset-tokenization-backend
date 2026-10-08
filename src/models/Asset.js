import mongoose from "mongoose";
import { isDbConnected } from "../config/db.js";

const assetSchema = new mongoose.Schema({
  assetId: { type: Number, required: true, unique: true },
  name: { type: String, required: true },
  symbol: { type: String, required: true },
  propertyType: { type: String, default: "Residential Real Estate" },
  location: { type: String, required: true },
  description: { type: String, default: "" },
  valuationLKR: { type: Number, required: true },
  totalShares: { type: Number, required: true },
  sharePriceLKR: { type: Number, required: true },
  metadataURI: { type: String, required: true },
  documentHash: { type: String, required: true },
  imageUrl: { type: String, default: "" },
  issuerWallet: { type: String, required: true },
  status: {
    type: String,
    enum: ["Pending", "Approved", "Tokenized", "Rejected"],
    default: "Pending"
  },
  txHash: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
  tokenizedAt: { type: Date }
});

const MongoAsset = mongoose.model("Asset", assetSchema);

// In-Memory Seed Assets matching our seeded blockchain contracts
const inMemoryAssets = [
  {
    assetId: 1,
    name: "Colombo Oceanfront Residence",
    symbol: "COR-01",
    propertyType: "Luxury Residential Penthouse",
    location: "Kollupitiya, Marine Drive, Colombo 03, Sri Lanka",
    description: "Premium three-bedroom ocean-facing luxury penthouse with panoramic views of the Indian Ocean, private terrace, and 24/7 dedicated concierge service.",
    valuationLKR: 10000000,
    totalShares: 1000,
    sharePriceLKR: 10000,
    metadataURI: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/colombo-apartment.json",
    documentHash: "0x9f83c6138438914b1bf0597bc5f8f5339f40feef2c95e5d326f9661d9a5b6d92",
    imageUrl: "https://images.unsplash.com/photo-1545324418-cc1a3fa10c00?auto=format&fit=crop&w=1200&q=80",
    issuerWallet: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    status: "Tokenized",
    txHash: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    createdAt: new Date(),
    tokenizedAt: new Date()
  },
  {
    assetId: 2,
    name: "Kandy Royal Commercial Plaza",
    symbol: "KRP-02",
    propertyType: "Commercial Retail & Office Plaza",
    location: "Dalada Veediya, Kandy City Center, Sri Lanka",
    description: "High-yield commercial hub comprising four storeys of grade-A retail storefronts and corporate executive suites with high footfall near the historic Kandy lake.",
    valuationLKR: 50000000,
    totalShares: 5000,
    sharePriceLKR: 10000,
    metadataURI: "ipfs://bafybeihkoviema7g3gx4e2lrtqfop4x42m66x4o2j2v65p3zldu54nhe2y/kandy-plaza.json",
    documentHash: "0x7c2d5e3f4b6a9c1e2d3b4a5c6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f",
    imageUrl: "https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?auto=format&fit=crop&w=1200&q=80",
    issuerWallet: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    status: "Pending",
    txHash: "",
    createdAt: new Date()
  },
  {
    assetId: 3,
    name: "Galle Dutch Fort Heritage Villa",
    symbol: "GFV-03",
    propertyType: "Hospitality & Heritage Villa",
    location: "Leyn Baan Street, Galle Fort, Southern Province, Sri Lanka",
    description: "Restored 18th-century Dutch colonial boutique hotel within a UNESCO World Heritage site, featuring six suites, courtyards, and verified tourist revenue streams.",
    valuationLKR: 25000000,
    totalShares: 2500,
    sharePriceLKR: 10000,
    metadataURI: "ipfs://bafybeicg4f3qpm5u3vx6z7h4h7q2x6o2q4f5o6z7a8b9c0d1e2f3a4b5c6/galle-villa.json",
    documentHash: "0x4a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b",
    imageUrl: "https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?auto=format&fit=crop&w=1200&q=80",
    issuerWallet: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    status: "Pending",
    txHash: "",
    createdAt: new Date()
  }
];

export const Asset = {
  async find(filter = {}) {
    if (isDbConnected()) {
      return await MongoAsset.find(filter).sort({ assetId: 1 });
    }
    return inMemoryAssets.filter(item => {
      if (filter.status && item.status !== filter.status) return false;
      if (filter.issuerWallet && item.issuerWallet.toLowerCase() !== filter.issuerWallet.toLowerCase()) return false;
      return true;
    });
  },

  async findOne(query) {
    if (isDbConnected()) {
      return await MongoAsset.findOne(query);
    }
    if (query.assetId !== undefined) {
      return inMemoryAssets.find(a => a.assetId === Number(query.assetId)) || null;
    }
    return null;
  },

  async create(data) {
    if (isDbConnected()) {
      const doc = new MongoAsset(data);
      return await doc.save();
    }
    const newAsset = {
      ...data,
      assetId: data.assetId || (inMemoryAssets.length > 0 ? Math.max(...inMemoryAssets.map(a => a.assetId)) + 1 : 1),
      createdAt: new Date()
    };
    inMemoryAssets.push(newAsset);
    return newAsset;
  },

  async updateOne(query, update) {
    if (isDbConnected()) {
      return await MongoAsset.updateOne(query, update);
    }
    const asset = inMemoryAssets.find(a => a.assetId === Number(query.assetId));
    if (asset) {
      Object.assign(asset, update.$set || update);
      return { modifiedCount: 1 };
    }
    return { modifiedCount: 0 };
  },

  async countDocuments(filter = {}) {
    if (isDbConnected()) {
      return await MongoAsset.countDocuments(filter);
    }
    return inMemoryAssets.filter(item => {
      if (filter.status && item.status !== filter.status) return false;
      return true;
    }).length;
  }
};
