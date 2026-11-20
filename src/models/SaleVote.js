import mongoose from "mongoose";

// A property-sale vote a holder signed off-chain (EIP-712). The platform relays pending votes in one batch transaction.
const saleVoteSchema = new mongoose.Schema(
  {
    offerId: { type: Number, required: true, index: true },
    voter: { type: String, required: true, lowercase: true },
    support: { type: Number, enum: [1, 2], required: true }, // 1 = yes, 2 = no
    signature: { type: String, required: true },
    relayed: { type: Boolean, default: false },
    relayTxHash: { type: String },
  },
  { timestamps: true }
);

saleVoteSchema.index({ offerId: 1, voter: 1 }, { unique: true });

export const SaleVote = mongoose.models.SaleVote || mongoose.model("SaleVote", saleVoteSchema);
