import mongoose from "mongoose";

// Append-only trail of every action on a valuation proposal.
const valuationAuditLogSchema = new mongoose.Schema(
  {
    assetId: { type: Number, required: true, index: true },
    proposalId: { type: String, required: true, index: true },
    valuationVersion: { type: Number, default: null },
    actor: { userId: String, name: String, email: String, role: String },
    action: {
      type: String,
      required: true,
      enum: [
        "SUBMITTED", "APPROVED", "REJECTED",
        "PUBLICATION_STARTED", "PUBLICATION_FAILED", "PUBLISHED", "RECONCILED_FROM_CHAIN",
      ],
    },
    previousStatus: String,
    newStatus: String,
    reason: String,
    blockchainTransactionHash: String,
    details: { type: mongoose.Schema.Types.Mixed },
    timestamp: { type: Date, default: Date.now },
  },
  { collection: "ValuationAuditLogs" }
);

export const ValuationAuditLog =
  mongoose.models.ValuationAuditLog || mongoose.model("ValuationAuditLog", valuationAuditLogSchema);
export default ValuationAuditLog;
