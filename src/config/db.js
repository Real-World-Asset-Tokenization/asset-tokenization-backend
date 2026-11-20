import mongoose from "mongoose";

// Do not queue operations for ten seconds when MongoDB is unavailable.
mongoose.set("bufferCommands", false);
let retryTimer;
let connectionAttempt;

function scheduleReconnect() {
  if (retryTimer || !process.env.MONGO_URI) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void connectDB();
  }, 15000);
  retryTimer.unref();
}

mongoose.connection.on("disconnected", scheduleReconnect);

export async function connectDB() {
  if (isDbConnected()) return true;
  if (connectionAttempt) return connectionAttempt;
  connectionAttempt = openConnection();
  try {
    return await connectionAttempt;
  } finally {
    connectionAttempt = undefined;
  }
}

async function openConnection() {
  const mongoURI = process.env.MONGO_URI;

  if (!mongoURI) {
    console.log("[MongoDB] No MONGO_URI specified. Asset fallback is available; authentication and KYC require MongoDB.");
    return false;
  }

  try {
    await mongoose.connect(mongoURI, {
      serverSelectionTimeoutMS: 15000,
    });
    clearTimeout(retryTimer);
    retryTimer = undefined;
    console.log("✔ [MongoDB] Connected successfully to Azure Cosmos DB.");
    return true;
  } catch (err) {
    console.warn("⚠ [MongoDB] Connection error:", err.message);
    console.log("[MongoDB] Asset fallback is available. Authentication and KYC are unavailable until MongoDB reconnects. Check MONGO_URI and database network access.");
    scheduleReconnect();
    return false;
  }
}

export function isDbConnected() {
  return mongoose.connection.readyState === 1;
}
