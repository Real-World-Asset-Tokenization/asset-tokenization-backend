import mongoose from "mongoose";

// One holder's share of a settled property sale, with the Merkle proof they need to claim it.
const salePayoutSchema = new mongoose.Schema(
  {
    offerId: { type: Number, required: true, index: true },
    claimant: { type: String, required: true, lowercase: true },
    amount: { type: String, required: true }, // payment token base units
    proof: { type: [String], default: [] },
  },
  { timestamps: true }
);

salePayoutSchema.index({ offerId: 1, claimant: 1 }, { unique: true });

export const SalePayout = mongoose.models.SalePayout || mongoose.model("SalePayout", salePayoutSchema);
