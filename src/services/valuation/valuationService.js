import fs from "fs/promises";
import mongoose from "mongoose";
import PropertyValuation from "../../models/PropertyValuation.js";
import ValuationAuditLog from "../../models/ValuationAuditLog.js";
import ValuationReviewRequest from "../../models/ValuationReviewRequest.js";
import { Asset } from "../../models/Asset.js";
import { readAssetState, listAssetIds, getOnChainHistory, hashBytes, hashText } from "./blockchainValuationService.js";
import { getPricing } from "./tokenReferencePricingService.js";
import { parseWholeLkr, referencePriceCents, centsToDecimal, percentChange, MoneyError } from "./money.js";

export class ValuationError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export const OPEN_STATUSES = ["PENDING_APPROVAL", "APPROVED"];
export const actorOf = (user) => ({ userId: String(user._id), name: user.name, email: user.email, role: user.role });

export async function audit(proposal, action, actor, extra = {}) {
  await ValuationAuditLog.create({
    assetId: proposal.assetId,
    proposalId: String(proposal._id),
    valuationVersion: proposal.valuationVersion ?? null,
    actor,
    action,
    ...extra,
  });
}

async function assetStateOr404(assetId) {
  try {
    return await readAssetState(assetId);
  } catch (err) {
    if (String(err.reason || err.shortMessage || err.message).includes("does not exist")) {
      throw new ValuationError(`Asset #${assetId} does not exist on-chain`, 404);
    }
    throw err;
  }
}

const parseAssetId = (v) => {
  const id = Number(v);
  if (!Number.isSafeInteger(id) || id < 1) throw new ValuationError("Invalid asset id");
  return id;
};

// ---------- reads ----------

export async function listRevaluableAssets() {
  const ids = await listAssetIds();
  const states = await Promise.all(ids.map((id) => readAssetState(id)));
  const open = await PropertyValuation.find({ status: { $in: OPEN_STATUSES } }).lean();
  return states
    .filter((s) => s.status === "Tokenized" && BigInt(s.tokenSupply) > 0n)
    .map((s) => {
      const price = referencePriceCents(s.valuation, s.tokenSupply);
      const pending = open.find((p) => p.assetId === s.assetId);
      return {
        ...s,
        referencePriceCents: price.toString(),
        referencePrice: centsToDecimal(price),
        lastValuationDate: s.latestRecord ? s.latestRecord.effectiveDate : s.registeredAt,
        openProposal: pending ? { id: String(pending._id), status: pending.status } : null,
      };
    });
}

export async function getPropertyValuation(assetId) {
  const id = parseAssetId(assetId);
  await assetStateOr404(id);
  return getPricing(id);
}

// Published history: on-chain records joined with the Azure proposal that produced each one.
export async function getValuationHistory(assetId) {
  const id = parseAssetId(assetId);
  const state = await assetStateOr404(id);
  const [chain, docs] = await Promise.all([
    getOnChainHistory(id),
    PropertyValuation.find({ assetId: id, status: "PUBLISHED" }).lean(),
  ]);
  const byRef = new Map(docs.map((d) => [d.proposalRef, d]));
  const baselineValue = chain.length ? chain[0].previousValuation : state.valuation;
  const entries = [{
    version: 0,
    approvedValue: baselineValue,
    referencePrice: centsToDecimal(referencePriceCents(baselineValue, state.tokenSupply)),
    effectiveDate: state.registeredAt,
    note: "Valuation approved at registration and tokenization",
    verifiedOnChain: true,
  }];
  for (const rec of chain) {
    const doc = byRef.get(rec.proposalRef);
    entries.push({
      version: rec.version,
      approvedValue: rec.valuation,
      previousValue: rec.previousValuation,
      changePercent: percentChange(rec.previousValuation, rec.valuation),
      referencePrice: centsToDecimal(referencePriceCents(rec.valuation, rec.tokenSupply)),
      tokenSupply: rec.tokenSupply,
      effectiveDate: rec.effectiveDate,
      publishedAt: rec.publishedAt,
      transactionHash: rec.transactionHash,
      blockNumber: rec.blockNumber,
      reportHash: rec.reportHash,
      verifiedOnChain: true,
      proposalId: doc ? String(doc._id) : null,
      source: doc?.source || null,
      reason: doc?.submissionReason || null,
      supportingDocument: doc ? { reference: doc.supportingDocument?.reference, fileName: doc.supportingDocument?.fileName, hash: doc.supportingDocument?.hash } : null,
      submittedBy: doc?.submittedBy?.name || null,
      approvedBy: doc?.approvedBy?.name || null,
      approvalTimestamp: doc?.approvalTimestamp || null,
      azureRecordMissing: !doc,
    });
  }
  return { assetId: id, propertyName: state.name, registryInSync: state.registryInSync, entries };
}

export async function listProposals({ status, assetId } = {}) {
  const filter = {};
  if (status) filter.status = { $in: String(status).split(",") };
  if (assetId) filter.assetId = parseAssetId(assetId);
  const docs = await PropertyValuation.find(filter).lean();
  // Sorted in memory: Cosmos DB needs an index for every server-side sort.
  return docs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map(present);
}

export async function getProposal(id) {
  if (!mongoose.isValidObjectId(id)) throw new ValuationError("Proposal not found", 404);
  const doc = await PropertyValuation.findById(id).lean();
  if (!doc) throw new ValuationError("Proposal not found", 404);
  const logs = (await ValuationAuditLog.find({ proposalId: String(id) }).lean())
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  return { ...present(doc), auditLog: logs };
}

export function present(doc) {
  const d = { ...doc, id: String(doc._id) };
  d.previousReferencePrice = centsToDecimal(doc.previousReferencePriceCents);
  d.proposedReferencePrice = centsToDecimal(doc.proposedReferencePriceCents);
  if (doc.approvedReferencePriceCents) d.approvedReferencePrice = centsToDecimal(doc.approvedReferencePriceCents);
  d.valuationChangePercent = percentChange(doc.previousApprovedValue, doc.proposedValue);
  d.referencePriceChangePercent = percentChange(doc.previousReferencePriceCents, doc.proposedReferencePriceCents);
  if (d.supportingDocument) delete d.supportingDocument.storedPath; // never expose server paths
  return d;
}

// ---------- submit ----------

/**
 * Creates a PENDING_APPROVAL proposal. The official value is not touched.
 * `source` is MANUAL for people. A future ML component calls this same function with
 * source "ML_ESTIMATE" and sourceMetadata; it still needs human approval to publish.
 */
export async function submitProposal(input, user, { source = "MANUAL", sourceMetadata = null } = {}) {
  const assetId = parseAssetId(input.assetId);
  let proposedValue;
  try { proposedValue = parseWholeLkr(input.proposedValuation, "Proposed valuation"); }
  catch (e) { throw new ValuationError(e instanceof MoneyError ? e.message : "Invalid proposed valuation"); }

  if ((input.currency || "LKR") !== "LKR") throw new ValuationError("Only LKR valuations are supported in this version");

  const effectiveDate = new Date(input.effectiveDate);
  if (!input.effectiveDate || Number.isNaN(effectiveDate.getTime())) throw new ValuationError("A valid valuation effective date is required");
  if (effectiveDate.getTime() > Date.now()) throw new ValuationError("The valuation effective date cannot be in the future");

  const reason = String(input.reason || "").trim();
  if (reason.length < 10) throw new ValuationError("Give a reason for the revaluation (at least 10 characters)");
  if (reason.length > 2000) throw new ValuationError("Reason is too long (max 2000 characters)");
  const comments = String(input.comments || "").trim().slice(0, 2000);

  const reference = String(input.documentReference || "").trim().slice(0, 300);
  if (!input.file && !reference) throw new ValuationError("Upload the valuation report or enter its reference number");

  const state = await assetStateOr404(assetId);
  if (state.status !== "Tokenized") throw new ValuationError("Only verified, tokenized properties can be revalued");
  if (!state.registryInSync) throw new ValuationError("The registry value differs from the last published version. An administrator must reconcile it first.", 409);
  if (state.latestRecord && effectiveDate < new Date(state.latestRecord.effectiveDate)) {
    throw new ValuationError("The effective date is earlier than the current approved valuation");
  }
  if (proposedValue === BigInt(state.valuation)) throw new ValuationError("The proposed value is the same as the current approved value");

  const open = await PropertyValuation.findOne({ assetId, status: { $in: OPEN_STATUSES } }).lean();
  if (open) throw new ValuationError(`Asset #${assetId} already has an open proposal (${open.status}). Resolve it first.`, 409);

  const supply = BigInt(state.tokenSupply);
  const document = { reference: reference || undefined };
  if (input.file) {
    const bytes = await fs.readFile(input.file.path);
    Object.assign(document, {
      fileName: input.file.originalname, storedPath: input.file.path,
      mimeType: input.file.mimetype, size: input.file.size, hash: hashBytes(bytes),
    });
  } else {
    document.hash = hashText(reference);
  }

  const actor = actorOf(user);
  const doc = await PropertyValuation.create({
    assetId,
    tokenContract: state.tokenContract,
    propertyName: state.name,
    currency: "LKR",
    source,
    sourceMetadata,
    previousApprovedValue: state.valuation,
    previousReferencePriceCents: referencePriceCents(state.valuation, supply).toString(),
    proposedValue: proposedValue.toString(),
    existingTokenSupply: supply.toString(),
    proposedReferencePriceCents: referencePriceCents(proposedValue, supply).toString(),
    valuationEffectiveDate: effectiveDate,
    submissionReason: reason,
    comments,
    supportingDocument: document,
    status: "PENDING_APPROVAL",
    blockchainPublicationStatus: "NOT_STARTED",
    submittedBy: actor,
    submittedAt: new Date(),
  });
  await audit(doc, "SUBMITTED", actor, { newStatus: "PENDING_APPROVAL", reason, details: { source, proposedValue: doc.proposedValue } });
  await ValuationReviewRequest.updateMany({ assetId, status: "OPEN" }, { status: "ADDRESSED", addressedByProposalId: String(doc._id) });
  return present(doc.toObject());
}

// ---------- asset-owner review requests ----------

export async function requestReview(assetId, reason, user) {
  const id = parseAssetId(assetId);
  const text = String(reason || "").trim();
  if (text.length < 10) throw new ValuationError("Explain why a review is needed (at least 10 characters)");
  const state = await assetStateOr404(id);
  const dbAsset = (await Asset.findOne({ blockchainAssetId: id })) || (await Asset.findOne({ assetId: id }));
  const ownsByAccount = dbAsset?.ownerId && String(dbAsset.ownerId._id || dbAsset.ownerId) === String(user._id);
  const ownsByWallet = user.walletAddress && state.issuer.toLowerCase() === user.walletAddress.toLowerCase();
  if (!ownsByAccount && !ownsByWallet) throw new ValuationError("Only the owner of this property can request a review", 403);
  const existing = await ValuationReviewRequest.findOne({ assetId: id, status: "OPEN" }).lean();
  if (existing) throw new ValuationError("A review request for this property is already open", 409);
  const doc = await ValuationReviewRequest.create({ assetId: id, propertyName: state.name, requestedBy: actorOf(user), reason: text.slice(0, 2000) });
  return doc.toObject();
}

export async function listReviewRequests({ status = "OPEN", assetId } = {}) {
  const filter = { status };
  if (assetId) filter.assetId = parseAssetId(assetId);
  return (await ValuationReviewRequest.find(filter).lean()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}
