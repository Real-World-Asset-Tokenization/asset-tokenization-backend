import express from "express";
import { protect } from "../middleware/auth.js";
import { requireDatabase } from "../middleware/requireDatabase.js";
import { upload } from "../middleware/upload.js";
import { loadUser, requirePermission, hasPermission } from "../middleware/valuationPermissions.js";
import * as valuations from "../services/valuation/valuationService.js";
import * as approvals from "../services/valuation/valuationApprovalService.js";

// Manual revaluation -> approval -> blockchain publication -> reference price.
// Mounted at /api/valuations.
const router = express.Router();
const signedIn = [requireDatabase, protect, loadUser];
const PROPOSE = "VALUATION_PROPOSE";
const APPROVE = "VALUATION_APPROVE";

const handle = (fn) => async (req, res) => {
  try {
    res.json({ success: true, data: await fn(req, res) });
  } catch (err) {
    const status = err.status || (String(err.message).includes("does not exist") ? 404 : 500);
    if (status === 500) console.error("[valuations]", err);
    res.status(status).json({ success: false, message: err.reason || err.shortMessage || err.message });
  }
};

// ----- public reads (official, published values only) -----

/** Tokenized properties with their current approved valuation and reference price. */
router.get("/assets", requireDatabase, handle(() => valuations.listRevaluableAssets()));

/** Current approved valuation, supply, reference price, last trade price. */
router.get("/assets/:assetId", handle((req) => valuations.getPropertyValuation(req.params.assetId)));

/** Just the official reference price and its effective date. */
router.get("/assets/:assetId/reference-price", handle(async (req) => {
  const v = await valuations.getPropertyValuation(req.params.assetId);
  return {
    assetId: v.assetId, currency: v.currency, referencePrice: v.referencePrice, referencePriceCents: v.referencePriceCents,
    approvedValuation: v.approvedValuation, tokenSupply: v.tokenSupply, effectiveDate: v.lastValuationDate, valuationVersion: v.valuationVersion,
  };
}));

/** All published versions (blockchain records joined with their Azure approval details). */
router.get("/assets/:assetId/history", requireDatabase, handle((req) => valuations.getValuationHistory(req.params.assetId)));

// ----- signed in -----

/** What the signed-in user may do (drives which screens the frontend shows). */
router.get("/me/permissions", ...signedIn, handle((req) => ({
  canPropose: hasPermission(req.account, PROPOSE),
  canApprove: hasPermission(req.account, APPROVE),
  selfApprovalAllowed: approvals.selfApprovalAllowed(),
  role: req.account.role,
  userId: String(req.account._id),
})));

/** Asset owner asks for a revaluation review. Does not change any value. */
router.post("/assets/:assetId/review-requests", ...signedIn, handle((req) =>
  valuations.requestReview(req.params.assetId, req.body.reason, req.account)));

router.get("/review-requests", ...signedIn, requirePermission(PROPOSE, APPROVE), handle((req) =>
  valuations.listReviewRequests({ status: req.query.status || "OPEN", assetId: req.query.assetId })));

/** Submit a MANUAL proposal. Multipart: optional `document` file (PDF/JPG/PNG, 5 MB). */
router.post("/proposals", ...signedIn, requirePermission(PROPOSE), upload.single("document"), handle(async (req, res) => {
  if (req.body.source && req.body.source !== "MANUAL") {
    const err = new Error("Only MANUAL proposals can be submitted here"); err.status = 400; throw err;
  }
  res.status(201);
  return valuations.submitProposal({ ...req.body, file: req.file }, req.account, { source: "MANUAL" });
}));

router.get("/proposals", ...signedIn, requirePermission(PROPOSE, APPROVE), handle((req) =>
  valuations.listProposals({ status: req.query.status, assetId: req.query.assetId })));

router.get("/proposals/:id", ...signedIn, requirePermission(PROPOSE, APPROVE), handle((req) => valuations.getProposal(req.params.id)));

/** Approve, lock the version and publish to the blockchain. */
router.post("/proposals/:id/approve", ...signedIn, requirePermission(APPROVE), handle((req) =>
  approvals.approveProposal(req.params.id, req.account, req.body?.comment)));

router.post("/proposals/:id/reject", ...signedIn, requirePermission(APPROVE), handle((req) =>
  approvals.rejectProposal(req.params.id, req.account, req.body?.reason)));

/** Retry publication of an approved proposal (safe to repeat). */
router.post("/proposals/:id/publish", ...signedIn, requirePermission(APPROVE), handle((req) =>
  approvals.publishProposal(req.params.id, req.account)));

// multer errors (wrong file type / too large)
router.use((err, req, res, next) => {
  if (!err) return next();
  res.status(400).json({ success: false, message: err.message });
});

export default router;
