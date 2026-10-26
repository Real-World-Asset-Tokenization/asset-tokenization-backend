import express from "express";
import { body, validationResult } from "express-validator";
import {
  uploadDocument,
  uploadSelfie,
  reuploadKYCDocuments,
  verifyKYC,
  getKYCStatus,
  adminVerifyKYC,
  pipelineVerify,
  getKYCDetailsByUserId,
  updateKYCStatus,
} from "../controllers/kycController.js";
import { protect, authorize } from "../middleware/auth.js";
import { upload, uploadToCloudinaryMiddleware } from "../middleware/upload.js";

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

// Re-upload KYC documents (for failed verification)
router.post(
  "/reupload",
  protect,
  upload.fields([
    { name: "document", maxCount: 1 },
    { name: "selfie", maxCount: 1 },
  ]),
  uploadToCloudinaryMiddleware('kyc-documents'),
  reuploadKYCDocuments
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

export default router;