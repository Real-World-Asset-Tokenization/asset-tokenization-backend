import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import morgan from "morgan";

import { connectDB, isDbConnected } from "./config/db.js";

import authRoutes from "./routes/authRoutes.js";
import kycRoutes from "./routes/kycRoutes.js";
import assetRoutes from "./routes/assetRoutes.js";
import complianceRoutes from "./routes/complianceRoutes.js";
import marketplaceRoutes from "./routes/marketplaceRoutes.js";
import profitRoutes from "./routes/profitRoutes.js";
import distributionRoutes from "./routes/distributionRoutes.js";
import gasRoutes from "./routes/gasRoutes.js";
import tokenizationRoutes from "./routes/tokenizationRoutes.js";

import { pipelineVerify } from "./controllers/kycController.js";
import { protect } from "./middleware/auth.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5001;

// ==================== MIDDLEWARE ====================

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (
        origin === "http://localhost:5173" ||
        origin === "http://127.0.0.1:5173" ||
        origin === process.env.FRONTEND_URL ||
        /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
      ) {
        return callback(null, true);
      }
      return callback(null, true);
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept"],
    optionsSuccessStatus: 200,
  })
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(morgan("dev"));

// ==================== API ROUTES ====================

// Authentication and user management
app.use("/api/auth", authRoutes);

// KYC verification
app.use("/api/kyc", kycRoutes);

// Asset tokenization and asset document verification
app.use("/api/assets", assetRoutes);

// Compliance and administrative operations
app.use("/api/compliance", complianceRoutes);

// Token Marketplace & secondary peer-to-peer trading
app.use("/api/marketplace", marketplaceRoutes);

// Financial reports & time-weighted profit calculation
app.use("/api/profit", profitRoutes);

// Merkle-based dividend distribution rounds & investor claims
app.use("/api/distribution", distributionRoutes);

// Gas analytics, fee monitoring & research benchmarks
app.use("/api/gas", gasRoutes);

// Owner-initiated tokenization module (Dual-Price Model, preview, verification, Azure reconciliation)
app.use("/api/tokenization", tokenizationRoutes);

// AI document verification pipeline
app.post("/api/pipeline/verify", protect, pipelineVerify);

// ==================== HEALTH CHECK ====================

app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "Asset Tokenization and KYC Backend API",
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/health", (req, res) => {
  res.status(isDbConnected() ? 200 : 503).json({
    status: isDbConnected() ? "online" : "degraded",
    service: "Asset Tokenization Backend API",
    database: isDbConnected()
      ? "Azure Cosmos DB for MongoDB API (Connected)"
      : "Azure Cosmos DB Disconnected (In-Memory Fallback Active)",
    timestamp: new Date().toISOString(),
  });
});

// ==================== 404 HANDLER ====================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "API route not found",
    path: req.originalUrl,
  });
});

// ==================== GLOBAL ERROR HANDLER ====================

app.use((err, req, res, next) => {
  console.error("Internal Server Error:", err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(err.status || 500).json({
    success: false,
    message:
      process.env.NODE_ENV === "production"
        ? "Internal Server Error"
        : err.message,
  });
});

// ==================== START SERVER ====================

async function startServer() {
  try {
    await connectDB();

    app.listen(PORT, () => {
      console.log("====================================================");
      console.log(`Asset Tokenization & KYC API: Port ${PORT}`);
      console.log(`Health: http://localhost:${PORT}/api/health`);
      console.log(`Auth: http://localhost:${PORT}/api/auth`);
      console.log(`KYC: http://localhost:${PORT}/api/kyc`);
      console.log(`Assets: http://localhost:${PORT}/api/assets`);
      console.log(`Compliance: http://localhost:${PORT}/api/compliance`);
      console.log(
        `AI Pipeline: http://localhost:${PORT}/api/pipeline/verify`
      );
      console.log("====================================================");
    });
  } catch (error) {
    console.error("Failed to start the backend:", error.message);
    process.exit(1);
  }
}

startServer();

export default app;