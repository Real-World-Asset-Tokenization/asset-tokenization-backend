import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { connectDB, isDbConnected } from "./config/db.js";
import assetRoutes from "./routes/assetRoutes.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5001;

// Middleware
app.use(cors({
  origin: "*", // Allow frontend development
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json());

// Routes
app.use("/api/assets", assetRoutes);

app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    service: "Asset Tokenization Backend API",
    database: isDbConnected() ? "MongoDB Atlas (Connected)" : "In-Memory Repository (Active)",
    timestamp: new Date().toISOString()
  });
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: "API route not found" });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error("Internal Server Error:", err);
  res.status(500).json({ error: "Internal Server Error", message: err.message });
});

// Start Server
async function startServer() {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🚀 Asset Tokenization Backend running on port ${PORT}`);
    console.log(`📡 Health endpoint: http://localhost:${PORT}/api/health`);
    console.log(`🏢 Assets endpoint: http://localhost:${PORT}/api/assets`);
    console.log(`====================================================`);
  });
}

startServer();
