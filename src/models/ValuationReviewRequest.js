import mongoose from "mongoose";

// An asset owner asking for their property to be revalued. It never changes the
// value itself; a valuer reviews it and may submit a proposal.
const valuationReviewRequestSchema = new mongoose.Schema(
  {
    assetId: { type: Number, required: true, index: true },
    propertyName: String,
    requestedBy: { userId: String, name: String, email: String, role: String },
    reason: { type: String, required: true },
    status: { type: String, enum: ["OPEN", "ADDRESSED"], default: "OPEN", index: true },
    addressedByProposalId: String,
  },
  { timestamps: true, collection: "ValuationReviewRequests" }
);

export const ValuationReviewRequest =
  mongoose.models.ValuationReviewRequest || mongoose.model("ValuationReviewRequest", valuationReviewRequestSchema);
export default ValuationReviewRequest;
