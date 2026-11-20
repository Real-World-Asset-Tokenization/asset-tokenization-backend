import mongoose from "mongoose";

// A sell order the seller signed off-chain (EIP-712). Nothing is written to the chain until a buyer fills it.
const signedOrderSchema = new mongoose.Schema(
  {
    orderHash: { type: String, required: true, unique: true, index: true },
    seller: { type: String, required: true, lowercase: true, index: true },
    assetId: { type: Number, required: true, index: true },
    amount: { type: Number, required: true },
    // "fixed" offers carry their price. "follow" offers carry a premium and a floor, and are priced from the approved valuation when bought.
    kind: { type: String, enum: ["fixed", "follow"], default: "fixed" },
    premiumBps: { type: Number, default: 0 },
    floorPrice: { type: String, default: "0" },
    marketplace: { type: String, lowercase: true, index: true }, // the marketplace contract the order was signed for
    pricePerToken: { type: String, required: true }, // payment token base units ("0" for follow offers)
    paymentToken: { type: String, required: true },
    expiry: { type: Number, default: 0 }, // unix seconds, 0 = no expiration
    salt: { type: String, required: true },
    signature: { type: String, required: true },
    status: { type: String, enum: ["Active", "Cancelled"], default: "Active" },
  },
  { timestamps: true }
);

export const SignedOrder = mongoose.models.SignedOrder || mongoose.model("SignedOrder", signedOrderSchema);
