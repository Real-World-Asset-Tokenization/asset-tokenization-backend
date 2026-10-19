import mongoose from "mongoose";
import { isDbConnected } from "../config/db.js";

const financialReportSchema = new mongoose.Schema(
  {
    reportId: { type: String, required: true, unique: true, index: true },
    assetId: { type: Number, required: true, index: true },
    periodLabel: { type: String, required: true }, // e.g. "2026-Q1" or "2026-Month-01"
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    startTimestamp: { type: Number, required: true },
    endTimestamp: { type: Number, required: true },
    grossRentalIncome: { type: Number, required: true, default: 0 },
    operatingExpenses: { type: Number, required: true, default: 0 },
    maintenanceReserve: { type: Number, required: true, default: 0 },
    netOperatingProfit: { type: Number, required: true, default: 0 },
    carriedForwardLoss: { type: Number, required: true, default: 0 },
    distributableAmount: { type: Number, required: true, default: 0 },
    currency: { type: String, default: "mUSD" },
    reportHash: { type: String, required: true },
    status: {
      type: String,
      enum: ["Draft", "PendingApproval", "Approved", "Rejected"],
      default: "Draft"
    },
    approvedBy: { type: String },
    approvedAt: { type: Date },
    rejectionReason: { type: String },
    notes: { type: String }
  },
  { timestamps: true }
);

const MongoFinancialReport = mongoose.models.FinancialReport || mongoose.model("FinancialReport", financialReportSchema);

const inMemoryReports = [];

const matchesFilter = (item, filter) => {
  for (const key of Object.keys(filter)) {
    if (typeof filter[key] === "object" && filter[key] !== null) {
      if (filter[key].$gte !== undefined && item[key] < filter[key].$gte) return false;
      if (filter[key].$lte !== undefined && item[key] > filter[key].$lte) return false;
      if (filter[key].$in !== undefined && !filter[key].$in.includes(item[key])) return false;
    } else {
      if (String(item[key]).toLowerCase() !== String(filter[key]).toLowerCase()) return false;
    }
  }
  return true;
};

const FinancialReport = {
  async create(reportData) {
    if (isDbConnected()) {
      return MongoFinancialReport.create(reportData);
    }
    const record = { ...reportData, _id: String(Date.now() + Math.random()), createdAt: new Date() };
    inMemoryReports.push(record);
    return record;
  },

  async find(filter = {}) {
    if (isDbConnected()) {
      return MongoFinancialReport.find(filter).sort({ createdAt: -1 }).lean();
    }
    return inMemoryReports.filter((r) => matchesFilter(r, filter)).sort((a, b) => b.createdAt - a.createdAt);
  },

  async findOne(filter = {}) {
    if (isDbConnected()) {
      return MongoFinancialReport.findOne(filter).lean();
    }
    return inMemoryReports.find((r) => matchesFilter(r, filter)) || null;
  },

  async updateOne(filter, update) {
    const updates = update.$set || update;
    if (isDbConnected()) {
      return MongoFinancialReport.updateOne(filter, update);
    }
    const report = inMemoryReports.find((r) => matchesFilter(r, filter));
    if (report) {
      Object.assign(report, updates, { updatedAt: new Date() });
      return { acknowledged: true, modifiedCount: 1 };
    }
    return { acknowledged: true, modifiedCount: 0 };
  }
};

export default FinancialReport;
