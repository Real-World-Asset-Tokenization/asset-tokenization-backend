import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import morgan from "morgan";

import { connectDB, isDbConnected } from "./config/db.js";

import authRoutes from "./routes/authRoutes.js";
import kycRoutes from "./routes/kycRoutes.js";
import assetRoutes from "./routes/assetRoutes.js";
import complianceRoutes from "./routes/complianceRoutes.js";

import { pipelineVerify } from "./controllers/kycController.js";
import { protect } from "./middleware/auth.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5001;

// ==================== MIDDLEWARE ====================

app.use(
  cors({
    origin: process.env.FRONTEND_URL || "*",
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
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
      ? "MongoDB Atlas (Connected)"
      : "MongoDB Disconnected",
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