const mongoose = require("mongoose");

const complianceSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    unique: true,
  },
  riskScore: {
    type: Number,
    default: 0,
    min: 0,
    max: 100,
  },
  amlStatus: {
    type: String,
    enum: ["pending", "cleared", "flagged", "under_review"],
    default: "pending",
  },
  duplicateUserDetected: {
    type: Boolean,
    default: false,
  },
  duplicateAssetDetected: {
    type: Boolean,
    default: false,
  },
  identityVerified: {
    type: Boolean,
    default: false,
  },
  documentAuthentic: {
    type: Boolean,
    default: false,
  },
  faceMatchScore: {
    type: Number,
    default: 0,
  },
  approvalStatus: {
    type: String,
    enum: ["pending", "approved", "rejected", "manual_review"],
    default: "pending",
  },
  riskFactors: [{
    type: String,
  }],
  notes: {
    type: String,
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
  },
  reviewedAt: {
    type: Date,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Update the updatedAt field before saving
complianceSchema.pre("save", function () {
  this.updatedAt = Date.now();
});

module.exports = mongoose.model("Compliance", complianceSchema);
