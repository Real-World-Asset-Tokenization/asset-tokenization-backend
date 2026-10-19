import dotenv from "dotenv";
dotenv.config();

import { connectDB, isDbConnected } from "../config/db.js";
import mongoose from "mongoose";

async function main() {
  await connectDB();
  console.log("Connected:", isDbConnected());

  const collection = mongoose.connection.collection("assets");
  const count = await collection.countDocuments();
  console.log("Assets count in Cosmos DB:", count);

  const existing1 = await collection.findOne({ assetId: 1 });
  console.log("Asset 1 exists in Cosmos DB:", !!existing1);

  if (!existing1) {
    console.log("Seeding Colombo Oceanfront Residence into Cosmos DB...");
    await collection.insertOne({
      assetId: 1,
      name: "Colombo Oceanfront Residence",
      assetName: "Colombo Oceanfront Residence",
      symbol: "COR-01",
      propertyType: "Luxury Residential Penthouse",
      assetType: "real_estate",
      location: "Kollupitiya, Marine Drive, Colombo 03, Sri Lanka",
      description: "Premium three-bedroom ocean-facing luxury penthouse.",
      valuationLKR: 10000000,
      valuation: 10000000,
      currency: "LKR",
      totalShares: 1000,
      sharePriceLKR: 10000,
      metadataURI: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/colombo-apartment.json",
      documentHash: "0x9f83c6138438914b1bf0597bc5f8f5339f40feef2c95e5d326f9661d9a5b6d92",
      imageUrl: "https://images.unsplash.com/photo-1545324418-cc1a3fa10c00?auto=format&fit=crop&w=1200&q=80",
      issuerWallet: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      status: "Approved",
      txHash: "",
      verificationStatus: "approved",
      documentAuthentic: true,
      ownershipVerified: true,
      aiGenerated: false,
      manipulationDetected: false,
      createdAt: new Date(),
      verifiedAt: new Date(),
    });
    console.log("✔ Seeded Asset #1 (Colombo Oceanfront Residence, Approved)");
  }

  const existing2 = await collection.findOne({ assetId: 2 });
  if (!existing2) {
    await collection.insertOne({
      assetId: 2,
      name: "Kandy Royal Commercial Plaza",
      assetName: "Kandy Royal Commercial Plaza",
      symbol: "KRP-02",
      propertyType: "Commercial Retail & Office Plaza",
      assetType: "real_estate",
      location: "Dalada Veediya, Kandy City Center, Sri Lanka",
      description: "Commercial retail and office plaza near Kandy Lake.",
      valuationLKR: 50000000,
      valuation: 50000000,
      currency: "LKR",
      totalShares: 5000,
      sharePriceLKR: 10000,
      metadataURI: "ipfs://bafybeihkoviema7g3gx4e2lrtqfop4x42m66x4o2j2v65p3zldu54nhe2y/kandy-plaza.json",
      documentHash: "0x7c2d5e3f4b6a9c1e2d3b4a5c6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f",
      imageUrl: "https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?auto=format&fit=crop&w=1200&q=80",
      issuerWallet: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      status: "Approved",
      txHash: "",
      verificationStatus: "approved",
      documentAuthentic: true,
      ownershipVerified: true,
      createdAt: new Date(),
      verifiedAt: new Date(),
    });
    console.log("✔ Seeded Asset #2 (Kandy Plaza, Approved)");
  }

  process.exit(0);
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
