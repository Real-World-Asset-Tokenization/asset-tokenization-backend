import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

import { connectDB } from "../config/db.js";
import { Asset } from "../models/Asset.js";

async function main() {
  await connectDB();
  console.log("Connected to MongoDB / Azure Cosmos DB.");

  const assets = await Asset.find();
  console.log(`Found ${assets.length} assets in DB.`);

  for (const asset of assets) {
    let bcId = asset.blockchainAssetId;
    
    if (asset.assetId === 1) bcId = 1;
    else if (asset.assetId === 2) bcId = 2;
    else if (asset.assetId === 3) bcId = 3;
    else if (asset.assetId === 847306 || asset.assetName === "test" || asset.name === "test") bcId = 4;
    else if (!bcId) bcId = asset.assetId;

    asset.blockchainAssetId = bcId;
    
    // Also ensure approved status is set
    if (asset.assetId === 3 || asset.assetId === 847306 || asset.assetId === 2) {
      asset.status = "Approved";
      asset.verificationStatus = "approved";
    }

    await asset.save();
    console.log(`Updated Asset #${asset.assetId} (${asset.name}): blockchainAssetId=${bcId}, status=${asset.status}`);
  }

  console.log("All assets synchronized successfully!");
  process.exit(0);
}

main().catch(err => {
  console.error("Sync error:", err);
  process.exit(1);
});
