import mongoose from "mongoose";

const spvSchema = new mongoose.Schema({
  assetId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Asset",
    required: true,
    index: true,
  },

  spvName: {
    type: String,
    required: true,
  },

  spvRegistrationNumber: {
    type: String,
    required: true,
    unique: true,
  },

  spvAddress: {
    type: String,
    required: true,
  },

  spvDocumentHash: {
    type: String,
    required: true,
  },

  status: {
    type: String,
    enum: ["pending", "created", "active"],
    default: "pending",
    index: true,
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },

  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
  },
});

export default mongoose.model("SPV", spvSchema);
