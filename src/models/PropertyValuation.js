import mongoose from "mongoose";

// One document per valuation proposal. Approved/published versions are never edited
// afterwards; a new valuation is always a new document, so history is preserved.
//
// Money is stored as decimal-digit strings (whole LKR, or LKR cents for prices) to
// avoid floating-point rounding. Use services/valuation/money.js to read and write them.

export const PROPOSAL_STATUS = ["PENDING_APPROVAL", "APPROVED", "REJECTED", "PUBLISHED"];
export const PUBLICATION_STATUS = ["NOT_STARTED", "PENDING", "SUBMITTED", "CONFIRMED", "FAILED"];
export const PROPOSAL_SOURCES = ["MANUAL", "ML_ESTIMATE"];

const digits = { type: String, match: /^\d+$/ };
const actor = new mongoose.Schema(
  { userId: String, name: String, email: String, role: String },
  { _id: false }
);

const propertyValuationSchema = new mongoose.Schema(
  {
    assetId: { type: Number, required: true, index: true },   // on-chain asset id = ERC-1155 token id
    tokenContract: { type: String, required: true },
    propertyName: { type: String, required: true },
    currency: { type: String, enum: ["LKR"], default: "LKR" },

    source: { type: String, enum: PROPOSAL_SOURCES, default: "MANUAL" },
    // Filled only for ML_ESTIMATE proposals (model version, confidence, evidence ...).
    sourceMetadata: { type: mongoose.Schema.Types.Mixed, default: null },

    previousApprovedValue: { ...digits, required: true },   // official value when submitted; refreshed on approval
    previousReferencePriceCents: { ...digits, required: true },
    proposedValue: { ...digits, required: true },
    approvedValue: digits,
    existingTokenSupply: { ...digits, required: true },
    proposedReferencePriceCents: { ...digits, required: true },
    approvedReferencePriceCents: digits,

    valuationVersion: { type: Number, default: null },     // assigned on approval; matches the on-chain version
    valuationEffectiveDate: { type: Date, required: true },
    submissionReason: { type: String, required: true },
    comments: { type: String, default: "" },
    supportingDocument: {
      reference: String,     // e.g. valuer report number
      fileName: String,
      storedPath: String,
      mimeType: String,
      size: Number,
      hash: { type: String, required: true },   // keccak256 of the file bytes, or of the reference text
    },

    status: { type: String, enum: PROPOSAL_STATUS, default: "PENDING_APPROVAL", index: true },
    submittedBy: actor,
    submittedAt: Date,
    approvedBy: actor,
    approvalTimestamp: Date,
    selfApproved: { type: Boolean, default: false },
    rejectedBy: actor,
    rejectedAt: Date,
    rejectionReason: String,

    blockchainPublicationStatus: { type: String, enum: PUBLICATION_STATUS, default: "NOT_STARTED" },
    publicationAttempts: { type: Number, default: 0 },
    publicationStartedAt: Date,
    lastPublicationError: String,
    blockchainTransactionHash: String,
    blockchainBlockNumber: Number,
    reportHash: String,      // bytes32 sent on-chain
    proposalRef: String,     // bytes32 sent on-chain = keccak256(proposal _id)
    publishedAt: Date,
  },
  { timestamps: true, collection: "PropertyValuations" }
);

export const PropertyValuation =
  mongoose.models.PropertyValuation || mongoose.model("PropertyValuation", propertyValuationSchema);
export default PropertyValuation;
