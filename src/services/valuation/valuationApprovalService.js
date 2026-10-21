import mongoose from "mongoose";
import PropertyValuation from "../../models/PropertyValuation.js";
import { Asset } from "../../models/Asset.js";
import { readAssetState, findPublication, publishValuation, hashText } from "./blockchainValuationService.js";
import { referencePriceCents } from "./money.js";
import { ValuationError, actorOf, audit, present } from "./valuationService.js";

// A SUBMITTED publication older than this is treated as interrupted and may be retried.
const STALE_SUBMISSION_MS = 2 * 60 * 1000;
const errText = (e) => e?.reason || e?.shortMessage || e?.message || String(e);

export const selfApprovalAllowed = () => String(process.env.VALUATION_ALLOW_SELF_APPROVAL).toLowerCase() === "true";

async function load(id) {
  if (!mongoose.isValidObjectId(id)) throw new ValuationError("Proposal not found", 404);
  const doc = await PropertyValuation.findById(id).lean();
  if (!doc) throw new ValuationError("Proposal not found", 404);
  return doc;
}

/**
 * Approves and locks a proposal, assigns the next on-chain version, then publishes it.
 * A publication failure does not undo the approval; the proposal stays APPROVED with
 * publication FAILED and can be retried with publish().
 */
export async function approveProposal(id, user, comment = "") {
  const doc = await load(id);
  if (doc.status !== "PENDING_APPROVAL") throw new ValuationError(`Proposal is ${doc.status}, not awaiting approval`, 409);

  const actor = actorOf(user);
  const isSelf = doc.submittedBy?.userId === actor.userId;
  if (isSelf && !selfApprovalAllowed()) {
    throw new ValuationError("The person who submitted a proposal cannot approve it. Ask a different approver.", 403);
  }

  const state = await readAssetState(doc.assetId);
  if (state.status !== "Tokenized") throw new ValuationError("Asset is no longer tokenized", 409);
  if (!state.registryInSync) throw new ValuationError("Registry value differs from the last published version; reconcile first", 409);
  if (state.tokenSupply !== doc.existingTokenSupply) throw new ValuationError("Token supply changed since submission. Reject and resubmit.", 409);
  if (state.latestRecord && new Date(doc.valuationEffectiveDate) < new Date(state.latestRecord.effectiveDate)) {
    throw new ValuationError("A newer valuation has been published since this was submitted. Reject it.", 409);
  }
  const other = await PropertyValuation.findOne({ assetId: doc.assetId, status: "APPROVED", _id: { $ne: doc._id } }).lean();
  if (other) throw new ValuationError("Another approved valuation for this asset is still waiting to be published", 409);

  const version = state.latestVersion + 1;
  // Atomic: only one approver can move it out of PENDING_APPROVAL.
  const approved = await PropertyValuation.findOneAndUpdate(
    { _id: doc._id, status: "PENDING_APPROVAL" },
    {
      $set: {
        status: "APPROVED",
        approvedValue: doc.proposedValue,
        previousApprovedValue: state.valuation,
        previousReferencePriceCents: referencePriceCents(state.valuation, state.tokenSupply).toString(),
        valuationVersion: version,
        approvedBy: actor,
        approvalTimestamp: new Date(),
        selfApproved: isSelf,
        reportHash: doc.supportingDocument.hash,
        proposalRef: hashText(String(doc._id)),
        blockchainPublicationStatus: "PENDING",
      },
    },
    { new: true, lean: true }
  );
  if (!approved) throw new ValuationError("This proposal was already processed by someone else", 409);
  await audit(approved, "APPROVED", actor, {
    previousStatus: "PENDING_APPROVAL", newStatus: "APPROVED", reason: comment || undefined,
    details: { version, selfApproved: isSelf },
  });

  return publishProposal(String(doc._id), user);
}

export async function rejectProposal(id, user, reason) {
  const text = String(reason || "").trim();
  if (text.length < 5) throw new ValuationError("Give a reason for rejecting (at least 5 characters)");
  const actor = actorOf(user);
  const rejected = await PropertyValuation.findOneAndUpdate(
    { _id: (await load(id))._id, status: "PENDING_APPROVAL" },
    { $set: { status: "REJECTED", rejectedBy: actor, rejectedAt: new Date(), rejectionReason: text.slice(0, 2000) } },
    { new: true, lean: true }
  );
  if (!rejected) throw new ValuationError("Only proposals awaiting approval can be rejected", 409);
  await audit(rejected, "REJECTED", actor, { previousStatus: "PENDING_APPROVAL", newStatus: "REJECTED", reason: text });
  return present(rejected);
}

/**
 * Publishes an APPROVED proposal. Safe to call repeatedly:
 *  - an atomic claim stops two publishes of the same proposal running at once;
 *  - before sending, the chain is checked: if this version is already there for this
 *    proposal (e.g. the tx was mined but the server crashed), Azure is just updated;
 *  - the contract itself rejects a duplicate or out-of-order version.
 */
export async function publishProposal(id, user) {
  const doc = await load(id);
  if (doc.status === "PUBLISHED") return present(doc);
  if (doc.status !== "APPROVED") throw new ValuationError(`Only approved proposals can be published (this one is ${doc.status})`, 409);

  const actor = actorOf(user);
  const claimed = await PropertyValuation.findOneAndUpdate(
    {
      _id: doc._id,
      status: "APPROVED",
      $or: [
        { blockchainPublicationStatus: { $in: ["PENDING", "FAILED"] } },
        { blockchainPublicationStatus: "SUBMITTED", publicationStartedAt: { $lt: new Date(Date.now() - STALE_SUBMISSION_MS) } },
      ],
    },
    { $set: { blockchainPublicationStatus: "SUBMITTED", publicationStartedAt: new Date(), lastPublicationError: null }, $inc: { publicationAttempts: 1 } },
    { new: true, lean: true }
  );
  if (!claimed) throw new ValuationError("Publication is already in progress. Try again in a couple of minutes if it does not finish.", 409);
  await audit(claimed, "PUBLICATION_STARTED", actor, { details: { attempt: claimed.publicationAttempts } });

  try {
    const existing = await findPublication(claimed.assetId, claimed.valuationVersion);
    if (existing) {
      if (existing.proposalRef !== claimed.proposalRef || existing.valuation !== claimed.approvedValue) {
        throw new Error(`Version ${claimed.valuationVersion} was already published by a different proposal. Reject this one and resubmit.`);
      }
      return await finalize(claimed, existing, actor, true);
    }

    const state = await readAssetState(claimed.assetId);
    if (state.latestVersion !== claimed.valuationVersion - 1) {
      throw new Error(`On-chain version is ${state.latestVersion}; expected ${claimed.valuationVersion - 1}. Reject and resubmit this proposal.`);
    }

    await publishValuation(
      {
        assetId: claimed.assetId,
        version: claimed.valuationVersion,
        valuation: claimed.approvedValue,
        effectiveDate: claimed.valuationEffectiveDate,
        reportHash: claimed.reportHash,
        proposalRef: claimed.proposalRef,
      },
      (hash) => PropertyValuation.updateOne({ _id: claimed._id }, { $set: { blockchainTransactionHash: hash } })
    );
    // Read back what the chain actually stored rather than trusting our inputs.
    const record = await findPublication(claimed.assetId, claimed.valuationVersion);
    if (!record || record.proposalRef !== claimed.proposalRef) throw new Error("Published record could not be verified on-chain");
    return await finalize(claimed, record, actor, false);
  } catch (err) {
    const message = errText(err);
    const failed = await PropertyValuation.findOneAndUpdate(
      { _id: claimed._id, status: "APPROVED" },
      { $set: { blockchainPublicationStatus: "FAILED", lastPublicationError: message } },
      { new: true, lean: true }
    );
    await audit(claimed, "PUBLICATION_FAILED", actor, { reason: message, blockchainTransactionHash: failed?.blockchainTransactionHash });
    return { ...present(failed || claimed), publicationError: message };
  }
}

async function finalize(doc, record, actor, reconciled) {
  const priceCents = referencePriceCents(record.valuation, record.tokenSupply);
  const published = await PropertyValuation.findOneAndUpdate(
    { _id: doc._id, status: "APPROVED" },
    {
      $set: {
        status: "PUBLISHED",
        blockchainPublicationStatus: "CONFIRMED",
        approvedReferencePriceCents: priceCents.toString(),
        blockchainTransactionHash: record.transactionHash,
        blockchainBlockNumber: record.blockNumber,
        publishedAt: new Date(record.publishedAt),
        lastPublicationError: null,
      },
    },
    { new: true, lean: true }
  );
  await audit(doc, reconciled ? "RECONCILED_FROM_CHAIN" : "PUBLISHED", actor, {
    previousStatus: "APPROVED", newStatus: "PUBLISHED", blockchainTransactionHash: record.transactionHash,
    details: { version: record.version, referencePriceCents: priceCents.toString() },
  });

  // Mirror into the existing assets collection used by older pages (display only).
  // Several Azure records can share a stale blockchainAssetId (old seed data), so only
  // update the one whose name matches the on-chain property; never guess.
  try {
    const candidates = (await Asset.find({ blockchainAssetId: doc.assetId }))
      .filter((a) => (a.name || a.assetName) === doc.propertyName);
    if (candidates.length === 1) {
      await Asset.findOneAndUpdate({ _id: candidates[0]._id }, {
        $set: { valuationLKR: Number(record.valuation), valuation: Number(record.valuation), sharePriceLKR: Number(priceCents) / 100 },
      });
    } else {
      console.warn(`[valuation] Asset mirror skipped for on-chain #${doc.assetId}: ${candidates.length} matching Azure records named "${doc.propertyName}"`);
    }
  } catch (e) {
    console.warn("[valuation] Asset mirror update skipped:", e.message);
  }
  return present(published || doc);
}
