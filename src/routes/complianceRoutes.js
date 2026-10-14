const express = require("express");
const { body, validationResult } = require("express-validator");
const {
  runComplianceCheck,
  getComplianceReport,
  manualReview,
  getAllComplianceRecords,
} = require("../controllers/complianceController");
const { protect } = require("../middleware/auth");

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

// Validation rules for manual review
const manualReviewValidation = [
  body("approvalStatus")
    .trim()
    .notEmpty()
    .withMessage("Approval status is required")
    .isIn(["approved", "rejected", "manual_review"])
    .withMessage("Invalid approval status"),
  body("notes")
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage("Notes must not exceed 500 characters"),
];

// Routes
router.post("/check", protect, runComplianceCheck);

router.get("/report", protect, getComplianceReport);

router.post(
  "/review/:userId",
  protect,
  manualReviewValidation,
  validate,
  manualReview
);

router.get("/records", protect, getAllComplianceRecords);

module.exports = router;
