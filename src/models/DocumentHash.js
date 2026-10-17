import mongoose from "mongoose";

const documentHashSchema = new mongoose.Schema({
  hash: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  assetId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Asset",
    required: true,
  },
  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  uploadDate: {
    type: Date,
    default: Date.now,
  },
});

// Index for faster duplicate queries
documentHashSchema.index({ hash: 1, uploadDate: -1 });

export default mongoose.model("DocumentHash", documentHashSchema);
