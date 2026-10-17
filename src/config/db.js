import mongoose from "mongoose";

let isConnected = false;

export async function connectDB() {
  const mongoURI = process.env.MONGO_URI;

  if (!mongoURI) {
    console.log("ℹ [MongoDB] No MONGO_URI specified. Operating with persistent in-memory repository.");
    return false;
  }

  try {
    await mongoose.connect(mongoURI, {
      serverSelectionTimeoutMS: 4000,
    });
    isConnected = true;
    console.log("✔ [MongoDB] Connected successfully to Azure Cosmos DB.");
    return true;
  } catch (err) {
    console.warn("⚠ [MongoDB] Connection error:", err.message);
    console.log("ℹ [MongoDB] Falling back gracefully to in-memory repository for local demonstration.");
    return false;
  }
}

export function isDbConnected() {
  return isConnected;
}
