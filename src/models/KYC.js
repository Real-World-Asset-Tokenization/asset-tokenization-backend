import mongoose from "mongoose";

const kycSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    unique: true,
  },
  idType: {
    type: String,
    enum: ["national_id", "passport", "driving_license"],
    required: true,
  },
  idNumber: {
    type: String,
    required: true,
  },
  documentImage: {
    type: String,
    required: true,
  },
  documentImagePublicId: {
    type: String,
  },
  selfie: {
    type: String,
  },
  selfiePublicId: {
    type: String,
  },
  faceScore: {
    type: Number,
    default: 0,
  },
  ocrData: {
    fullName: String,
    idNumber: String,
    dateOfBirth: String,
    sex: String,
    address: String,
    dateOfIssue: String,
    placeOfBirth: String,
    // Legacy fields kept for backward compatibility
    nationality: String,
    expiryDate: String,
  },
  documentAuthentic: {
    type: Boolean,
    default: false,
  },
  verificationStatus: {
    type: String,
    enum: ["pending", "under_review", "approved", "rejected"],
    default: "pending",
  },
  riskScore: {
    type: Number,
    default: 0,
  },
  rejectionReason: {
    type: String,
  },
  verifiedAt: {
    type: Date,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },

  // ── Full pipeline results (persisted for audit trail) ──
  pipelineResults: {
    pipelineVersion: { type: String },
    pipelineRunAt: { type: Date },
    finalDecision: { type: String },
    abortedAt: { type: String },
    abortReason: { type: String },

    // Stage 1 — Image clarity
    stage1_clarity: {
      passed: Boolean,
      document: {
        passed: Boolean,
        qualityScore: Number,
        issues: [String],
        details: mongoose.Schema.Types.Mixed,
      },
      selfie: {
        passed: Boolean,
        qualityScore: Number,
        issues: [String],
        details: mongoose.Schema.Types.Mixed,
      },
    },

    // Stage 2 — OCR extraction
    stage2_ocr: {
      extractedData: mongoose.Schema.Types.Mixed,
      rawText: String,
      ocrMethod: String,
    },

    // Stage 3 — Face similarity
    stage3_face: {
      similarityScore: Number,
      match: Boolean,
      confidence: String,
      distance: Number,
      error: String,
    },

    // Stage 4 — Risk analysis
    stage4_risk: {
      riskScore: Number,
      riskLevel: String,
      decision: String,
      factors: mongoose.Schema.Types.Mixed,
    },
  },
});

export default mongoose.model("KYC", kycSchema);
