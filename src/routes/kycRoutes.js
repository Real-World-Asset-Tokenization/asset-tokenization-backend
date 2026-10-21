import express from "express";
import { body, validationResult } from "express-validator";
import {
  uploadDocument,
  uploadSelfie,
  verifyKYC,
  getKYCStatus,
  adminVerifyKYC,
  pipelineVerify,
  getKYCDetailsByUserId,
  updateKYCStatus,
} from "../controllers/kycController.js";
import { protect, authorize } from "../middleware/auth.js";
import { upload, uploadToCloudinaryMiddleware } from "../middleware/upload.js";
import KYC from "../models/KYC.js";

const router = express.Router();

// Validation middleware
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) {
    return next();
  }
  return res.status(400).json({
    success: false,
    errors: errors.array(),
  });
};

// Validation rules
const documentValidation = [
  body("idType")
    .trim()
    .notEmpty()
    .withMessage("ID type is required")
    .isIn(["national_id", "passport", "driving_license"])
    .withMessage("Invalid ID type"),
  body("idNumber")
    .trim()
    .notEmpty()
    .withMessage("ID number is required")
    .isLength({ min: 5 })
    .withMessage("ID number must be at least 5 characters"),
];

// Routes
router.post(
  "/upload-document",
  protect,
  upload.single("document"),
  uploadToCloudinaryMiddleware('kyc-documents'),
  documentValidation,
  validate,
  uploadDocument
);

router.post(
  "/upload-selfie",
  protect,
  upload.single("selfie"),
  uploadToCloudinaryMiddleware('kyc-selfies'),
  uploadSelfie
);

router.post("/verify", protect, verifyKYC);

// Proxy route to AI service pipeline (fetches images from database)
router.post("/pipeline/verify", protect, pipelineVerify);

router.get("/status", protect, getKYCStatus);

// Admin routes
router.post(
  "/admin/verify/:userId",
  protect,
  authorize("admin", "compliance_officer"),
  adminVerifyKYC
);

router.get(
  "/admin/details/:userId",
  protect,
  authorize("admin", "compliance_officer"),
  getKYCDetailsByUserId
);

router.put(
  "/admin/status/:userId",
  protect,
  authorize("admin", "compliance_officer"),
  updateKYCStatus
);

/**
 * GET /api/kyc/admin/summary
 * KYC counts by status and the latest submissions, for the admin dashboard.
 */
router.get("/admin/summary", protect, authorize("admin", "compliance_officer"), async (req, res) => {
  try {
    const records = await KYC.find({}, "userId verificationStatus createdAt verifiedAt").populate("userId", "name email role").lean();
    const counts = { pending: 0, under_review: 0, approved: 0, rejected: 0 };
    for (const r of records) counts[r.verificationStatus] = (counts[r.verificationStatus] || 0) + 1;
    const recent = records
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 6)
      .map((r) => ({
        userId: r.userId?._id, name: r.userId?.name, email: r.userId?.email, role: r.userId?.role,
        status: r.verificationStatus, submittedAt: r.createdAt, verifiedAt: r.verifiedAt,
      }));
    res.json({ success: true, data: { total: records.length, counts, recent } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;