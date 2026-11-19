import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import morgan from "morgan";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

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
import valuationRoutes from "./routes/valuationRoutes.js";
import orderRoutes from "./routes/orderRoutes.js";
import saleRoutes from "./routes/saleRoutes.js";

import { pipelineVerify } from "./controllers/kycController.js";
import { protect } from "./middleware/auth.js";
import { requireDatabase } from "./middleware/requireDatabase.js";
import { assertSecureEnvironment, allowedOrigins, isProduction } from "./config/security.js";

dotenv.config();
assertSecureEnvironment();

const app = express();
const PORT = process.env.PORT || 5001;

// ==================== MIDDLEWARE ====================

// Behind a reverse proxy / load balancer, trust it so rate limiting sees the real client IP.
if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY) || 1);
app.disable("x-powered-by");
app.use(helmet());

const origins = allowedOrigins();
app.use(
  cors({
    // Requests without an Origin header (curl, server-to-server) are not browser cross-site requests.
    origin: (origin, callback) => {
      if (!origin || origins.has(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept"],
    optionsSuccessStatus: 200,
  })
);

const limiter = (windowMs, max, message) =>
  rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, message: { success: false, message } });

// Brute-force protection on credentials, and a general ceiling on everything else.
app.use("/api/auth/login", limiter(15 * 60 * 1000, 10, "Too many login attempts. Try again later."));
app.use("/api/auth/register", limiter(60 * 60 * 1000, 20, "Too many sign-up attempts. Try again later."));
app.use("/api", limiter(60 * 1000, 300, "Too many requests. Slow down."));

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.use(morgan(isProduction() ? "combined" : "dev"));

// ==================== API ROUTES ====================

// Authentication and user management
app.use("/api/auth", requireDatabase, authRoutes);

// KYC verification
app.use("/api/kyc", requireDatabase, kycRoutes);

// Asset tokenization and asset document verification
app.use("/api/assets", assetRoutes);

// Compliance and administrative operations
app.use("/api/compliance", requireDatabase, complianceRoutes);

// Token Marketplace & secondary peer-to-peer trading
app.use("/api/marketplace", marketplaceRoutes);

// Off-chain signed sell orders (EIP-712): the seller signs, the buyer settles on-chain
app.use("/api/orders", orderRoutes);

// Full-property sale: buyer offers, token-holder voting (signed votes relayed in batches) and payout
app.use("/api/sales", saleRoutes);

// Financial reports & time-weighted profit calculation
app.use("/api/profit", profitRoutes);

// Merkle-based dividend distribution rounds & investor claims
app.use("/api/distribution", distributionRoutes);

// Gas analytics, fee monitoring & research benchmarks
app.use("/api/gas", gasRoutes);

// Owner-initiated tokenization module (Dual-Price Model, preview, verification, Azure reconciliation)
app.use("/api/tokenization", tokenizationRoutes);

// Manual revaluation, approval and blockchain publication
app.use("/api/valuations", valuationRoutes);

// AI document verification pipeline
app.post("/api/pipeline/verify", protect, requireDatabase, pipelineVerify);

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
      : "MongoDB disconnected (asset fallback only; authentication and KYC unavailable)",
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
