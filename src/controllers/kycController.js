import KYC from "../models/KYC.js";
import User from "../models/User.js";
import aiService from "../services/aiService.js";
import axios from "axios";
import FormData from "form-data";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cloudinary integration stub - can be implemented later
const deleteFromCloudinary = async (publicId) => {
  // Placeholder for Cloudinary deletion
  console.log(`Would delete Cloudinary image: ${publicId}`);
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Normalize NIC number for comparison
 * Removes spaces, special characters, and converts to uppercase
 * Handles Sri Lankan ID format variations (e.g., "123456789V", "123456789 v", "123456789X")
 */
function normalizeNICNumber(idNumber) {
  if (!idNumber) return "";
  // Remove all non-alphanumeric characters (keep letters and numbers only)
  const normalized = idNumber.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return normalized;
}

// Upload ID Document
export const uploadDocument = async (req, res) => {
  try {
    const { idType, idNumber } = req.body;
    const userId = req.user.userId;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Document image is required",
      });
    }

    // Check if KYC already exists for this user
    const existingKYC = await KYC.findOne({ userId });
    if (existingKYC) {
      return res.status(400).json({
        success: false,
        message: "KYC document already uploaded. Use update instead.",
      });
    }

    // ── Validate NIC number using OCR extraction ──
    let documentPath;
    const tempDir = path.join(__dirname, "../../temp");
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    try {
      // Resolve image path (local file or remote URL)
      const getImagePath = async (imageUrl, fileName) => {
        if (!imageUrl) {
          throw new Error("Image URL is undefined");
        }
        if (imageUrl.match(/^[A-Za-z]:\\/)) {
          if (!fs.existsSync(imageUrl)) {
            throw new Error(`Local file not found: ${imageUrl}`);
          }
          return imageUrl;
        }
        const downloadPath = path.join(tempDir, fileName);
        const response = await axios({ method: "get", url: imageUrl, responseType: "stream" });
        const writer = fs.createWriteStream(downloadPath);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
          writer.on("finish", resolve);
          writer.on("error", reject);
        });
        return downloadPath;
      };

      documentPath = await getImagePath(
        req.file.path,
        `doc_${userId}_${Date.now()}.jpg`
      );

      // Call AI service to extract ID number from document
      const ocrResult = await aiService.extractTextFromDocument(documentPath);

      // Clean up temp file
      if (fs.existsSync(documentPath) && documentPath.startsWith(tempDir)) {
        fs.unlinkSync(documentPath);
      }

      // Extract NIC number from OCR result
      const extractedIdNumber = ocrResult?.data?.idNumber;

      if (!extractedIdNumber) {
        // OCR failed to extract ID number - delete local file and reject
        if (fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
        return res.status(400).json({
          success: false,
          message: "Failed to extract ID number from document. Please ensure the image is clear and readable.",
        });
      }

      // Normalize both numbers for comparison
      const normalizedEnteredId = normalizeNICNumber(idNumber);
      const normalizedExtractedId = normalizeNICNumber(extractedIdNumber);

      // Compare entered ID with OCR-extracted ID
      if (normalizedEnteredId !== normalizedExtractedId) {
        // ID number mismatch - delete local file and reject
        if (fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
        return res.status(400).json({
          success: false,
          message: "The ID number entered does not match the ID number extracted from the document. Please verify and try again.",
          details: {
            entered: idNumber,
            extracted: extractedIdNumber,
          },
        });
      }

      // Check if ID number already exists in database
      const existingIdNumber = await KYC.findOne({ idNumber: normalizedEnteredId });
      if (existingIdNumber) {
        // ID number already registered - delete local file and reject
        if (fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
        return res.status(400).json({
          success: false,
          message: "This ID number is already registered in the system. Each ID can only be used once.",
        });
      }

      // Validation passed - proceed with creating KYC record
      const kyc = await KYC.create({
        userId,
        idType,
        idNumber: normalizedEnteredId,
        documentImage: req.file.path,
        documentImagePublicId: req.file.filename,
        verificationStatus: "pending",
      });

      res.status(201).json({
        success: true,
        message: "Document uploaded successfully",
        data: {
          kycId: kyc._id,
          idType: kyc.idType,
          idNumber: kyc.idNumber,
          documentImage: kyc.documentImage,
          verificationStatus: kyc.verificationStatus,
        },
      });
    } catch (validationError) {
      // Clean up temp file if error occurred
      if (documentPath && fs.existsSync(documentPath) && documentPath.startsWith(tempDir)) {
        fs.unlinkSync(documentPath);
      }
      // Delete local file if validation failed
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      throw validationError;
    }
  } catch (error) {
    console.error("Upload document error:", error);
    res.status(500).json({
      success: false,
      message: "Error uploading document",
      error: error.message,
    });
  }
};

// Upload Selfie
export const uploadSelfie = async (req, res) => {
  try {
    const userId = req.user.userId;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Selfie image is required",
      });
    }

    // Find existing KYC record
    const kyc = await KYC.findOne({ userId });
    if (!kyc) {
      return res.status(404).json({
        success: false,
        message: "Please upload ID document first",
      });
    }

    // Update selfie with local file path
    kyc.selfie = req.file.path;
    kyc.selfiePublicId = req.file.filename;
    kyc.verificationStatus = "under_review";
    await kyc.save();

    res.status(200).json({
      success: true,
      message: "Selfie uploaded successfully",
      data: {
        kycId: kyc._id,
        selfie: kyc.selfie,
        verificationStatus: kyc.verificationStatus,
      },
    });
  } catch (error) {
    console.error("Upload selfie error:", error);
    res.status(500).json({
      success: false,
      message: "Error uploading selfie",
      error: error.message,
    });
  }
};

// ── Verify KYC (user-triggered, runs real AI pipeline) ──────────────────────
export const verifyKYC = async (req, res) => {
  try {
    const userId = req.user.userId;

    const kyc = await KYC.findOne({ userId });
    if (!kyc) {
      return res.status(404).json({
        success: false,
        message: "KYC record not found",
      });
    }

    if (!kyc.documentImage || !kyc.selfie) {
      return res.status(400).json({
        success: false,
        message: "Both document and selfie must be uploaded before verification",
      });
    }

    const tempDir = path.join(__dirname, "../../temp");
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    let documentPath, selfiePath;

    // Helper to resolve image path (local file or remote URL)
    const getImagePath = async (imageUrl, fileName) => {
      if (!imageUrl) {
        throw new Error("Image URL is undefined");
      }
      if (imageUrl.match(/^[A-Za-z]:\\/)) {
        if (!fs.existsSync(imageUrl)) {
          throw new Error(`Local file not found: ${imageUrl}`);
        }
        return imageUrl;
      }
      const downloadPath = path.join(tempDir, fileName);
      const response = await axios({ method: "get", url: imageUrl, responseType: "stream" });
      const writer = fs.createWriteStream(downloadPath);
      response.data.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
      });
      return downloadPath;
    };

    try {
      documentPath = await getImagePath(
        kyc.documentImage,
        `doc_${userId}_${Date.now()}.jpg`
      );
      selfiePath = await getImagePath(
        kyc.selfie,
        `selfie_${userId}_${Date.now()}.jpg`
      );

      // Run the full 4-stage KYC pipeline
      const pipelineResult = await aiService.runKYCPipeline(documentPath, selfiePath);

      // Persist pipeline results and update KYC record
      await _applyPipelineResults(kyc, pipelineResult);

      // Clean up temp files (only downloaded ones, not local paths)
      _cleanupTemp([documentPath, selfiePath], tempDir);

      return res.status(200).json({
        success: true,
        message: "KYC verification completed",
        data: {
          kycId: kyc._id,
          verificationStatus: kyc.verificationStatus,
          finalDecision: pipelineResult.finalDecision,
          riskScore: kyc.riskScore,
          faceScore: kyc.faceScore,
          documentAuthentic: kyc.documentAuthentic,
          ocrData: kyc.ocrData,
          pipelineResults: kyc.pipelineResults,
          rejectionReason: kyc.rejectionReason,
          verifiedAt: kyc.verifiedAt,
        },
      });
    } catch (processingError) {
      _cleanupTemp([documentPath, selfiePath], tempDir);
      throw processingError;
    }
  } catch (error) {
    console.error("Verify KYC error:", error);
    res.status(500).json({
      success: false,
      message: "Error verifying KYC",
      error: error.message,
    });
  }
};

// Get KYC Status
export const getKYCStatus = async (req, res) => {
  try {
    const userId = req.user.userId;

    const kyc = await KYC.findOne({ userId }).populate("userId", "name email role");
    if (!kyc) {
      return res.status(404).json({
        success: false,
        message: "KYC record not found",
      });
    }

    res.status(200).json({
      success: true,
      data: {
        kycId: kyc._id,
        verificationStatus: kyc.verificationStatus,
        idType: kyc.idType,
        idNumber: kyc.idNumber,
        faceScore: kyc.faceScore,
        documentAuthentic: kyc.documentAuthentic,
        riskScore: kyc.riskScore,
        ocrData: kyc.ocrData,
        pipelineResults: kyc.pipelineResults,
        rejectionReason: kyc.rejectionReason,
        createdAt: kyc.createdAt,
        verifiedAt: kyc.verifiedAt,
        documentImage: kyc.documentImage,
        selfie: kyc.selfie,
      },
    });
  } catch (error) {
    console.error("Get KYC status error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching KYC status",
      error: error.message,
    });
  }
};

// ── Get KYC Details by User ID (Admin only) ───────────────────────────────
export const getKYCDetailsByUserId = async (req, res) => {
  try {
    const { userId } = req.params;

    // Check if requester is admin or compliance officer
    const requester = await User.findById(req.user.userId);
    if (requester.role !== "admin" && requester.role !== "compliance_officer") {
      return res.status(403).json({
        success: false,
        message: "Only admins and compliance officers can view KYC details",
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const kyc = await KYC.findOne({ userId });
    if (!kyc) {
      return res.status(404).json({
        success: false,
        message: "KYC record not found for this user",
      });
    }

    res.status(200).json({
      success: true,
      data: {
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
        },
        kyc: {
          kycId: kyc._id,
          verificationStatus: kyc.verificationStatus,
          idType: kyc.idType,
          idNumber: kyc.idNumber,
          faceScore: kyc.faceScore,
          documentAuthentic: kyc.documentAuthentic,
          riskScore: kyc.riskScore,
          ocrData: kyc.ocrData,
          pipelineResults: kyc.pipelineResults,
          rejectionReason: kyc.rejectionReason,
          documentImage: kyc.documentImage,
          selfie: kyc.selfie,
          createdAt: kyc.createdAt,
          verifiedAt: kyc.verifiedAt,
        },
      },
    });
  } catch (error) {
    console.error("Get KYC details error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching KYC details",
      error: error.message,
    });
  }
};

// ── Update KYC Status (Admin only) ───────────────────────────────────────
export const updateKYCStatus = async (req, res) => {
  try {
    const { userId } = req.params;
    const { verificationStatus, rejectionReason } = req.body;

    // Check if requester is admin or compliance officer
    const requester = await User.findById(req.user.userId);
    if (requester.role !== "admin" && requester.role !== "compliance_officer") {
      return res.status(403).json({
        success: false,
        message: "Only admins and compliance officers can update KYC status",
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const kyc = await KYC.findOne({ userId });
    if (!kyc) {
      return res.status(404).json({
        success: false,
        message: "KYC record not found for this user",
      });
    }

    // Validate verification status
    const validStatuses = ["pending", "under_review", "approved", "rejected"];
    if (!validStatuses.includes(verificationStatus)) {
      return res.status(400).json({
        success: false,
        message: "Invalid verification status",
      });
    }

    // Update KYC status
    kyc.verificationStatus = verificationStatus;
    
    if (verificationStatus === "approved") {
      kyc.verifiedAt = new Date();
      kyc.rejectionReason = undefined;
      // Update user's isVerified field to true
      user.isVerified = true;
      user.verifiedBy = req.user.userId;
      user.verifiedAt = new Date();
    } else if (verificationStatus === "rejected") {
      kyc.rejectionReason = rejectionReason || "Rejected by admin";
      // Update user's isVerified field to false
      user.isVerified = false;
      user.verifiedBy = undefined;
      user.verifiedAt = undefined;
    } else {
      kyc.rejectionReason = undefined;
      // Update user's isVerified field to false for pending/under_review
      user.isVerified = false;
      user.verifiedBy = undefined;
      user.verifiedAt = undefined;
    }

    await kyc.save();
    await user.save();

    res.status(200).json({
      success: true,
      message: "KYC status updated successfully",
      data: {
        kycId: kyc._id,
        verificationStatus: kyc.verificationStatus,
        verifiedAt: kyc.verifiedAt,
        rejectionReason: kyc.rejectionReason,
      },
    });
  } catch (error) {
    console.error("Update KYC status error:", error);
    res.status(500).json({
      success: false,
      message: "Error updating KYC status",
      error: error.message,
    });
  }
};

// ── Admin Verify KYC by User ID (runs real AI pipeline) ─────────────────────
export const adminVerifyKYC = async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const kyc = await KYC.findOne({ userId });
    if (!kyc) {
      return res.status(404).json({
        success: false,
        message: "KYC record not found for this user",
      });
    }

    if (!kyc.documentImage || !kyc.selfie) {
      return res.status(400).json({
        success: false,
        message: "Both document and selfie must be uploaded before verification",
      });
    }

    const tempDir = path.join(__dirname, "../../temp");
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    let documentPath, selfiePath;

    // Helper to resolve image path (local file or remote URL)
    const getImagePath = async (imageUrl, fileName) => {
      if (!imageUrl) {
        throw new Error("Image URL is undefined");
      }
      if (imageUrl.match(/^[A-Za-z]:\\/)) {
        if (!fs.existsSync(imageUrl)) {
          throw new Error(`Local file not found: ${imageUrl}`);
        }
        console.log(`Using local file: ${imageUrl}`);
        return imageUrl;
      }
      console.log(`Downloading from URL: ${imageUrl}`);
      const downloadPath = path.join(tempDir, fileName);
      const response = await axios({ method: "get", url: imageUrl, responseType: "stream" });
      const writer = fs.createWriteStream(downloadPath);
      response.data.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
      });
      console.log(`Downloaded to: ${downloadPath}`);
      return downloadPath;
    };

    try {
      // Resolve document and selfie paths
      try {
        documentPath = await getImagePath(
          kyc.documentImage,
          `doc_${userId}_${Date.now()}.jpg`
        );
      } catch (docError) {
        return res.status(400).json({
          success: false,
          message: "Document image not accessible",
          error: `Cannot access document image: ${docError.message}`,
          documentImage: kyc.documentImage,
        });
      }

      try {
        selfiePath = await getImagePath(
          kyc.selfie,
          `selfie_${userId}_${Date.now()}.jpg`
        );
      } catch (selfieError) {
        return res.status(400).json({
          success: false,
          message: "Selfie image not accessible",
          error: `Cannot access selfie image: ${selfieError.message}`,
          selfie: kyc.selfie,
        });
      }

      // ── Run the full 4-stage KYC pipeline ──
      console.log(`[Admin KYC] Running pipeline for user ${userId}`);
      const pipelineResult = await aiService.runKYCPipeline(documentPath, selfiePath);
      console.log(`[Admin KYC] Pipeline result: decision=${pipelineResult.finalDecision} risk=${pipelineResult.stages?.stage4_risk?.riskScore}`);

      // Persist pipeline results into the KYC record
      await _applyPipelineResults(kyc, pipelineResult);

      // Clean up temporary files
      _cleanupTemp([documentPath, selfiePath], tempDir);

      return res.status(200).json({
        success: true,
        message: "KYC verification pipeline completed",
        data: {
          userId: user._id,
          userName: user.name,
          userEmail: user.email,
          kycId: kyc._id,
          verificationStatus: kyc.verificationStatus,
          finalDecision: pipelineResult.finalDecision,
          riskScore: kyc.riskScore,
          faceScore: kyc.faceScore,
          documentAuthentic: kyc.documentAuthentic,
          ocrData: kyc.ocrData,
          documentImage: kyc.documentImage,
          selfie: kyc.selfie,
          verifiedAt: kyc.verifiedAt,
          rejectionReason: kyc.rejectionReason,
          // Full pipeline stage-by-stage breakdown
          pipeline: {
            version: pipelineResult.pipelineVersion,
            abortedAt: pipelineResult.abortedAt,
            abortReason: pipelineResult.abortReason,
            stage1_clarity: pipelineResult.stages?.stage1_clarity,
            stage2_ocr: pipelineResult.stages?.stage2_ocr,
            stage3_face: pipelineResult.stages?.stage3_face,
            stage4_risk: pipelineResult.stages?.stage4_risk,
          },
          documentUrl: pipelineResult.documentUrl,
          selfieUrl: pipelineResult.selfieUrl,
        },
      });
    } catch (pipelineError) {
      console.error("[Admin KYC] Pipeline error:", pipelineError);
      _cleanupTemp([documentPath, selfiePath], tempDir);

      return res.status(500).json({
        success: false,
        message: "Error running KYC verification pipeline",
        error: pipelineError.message,
      });
    }
  } catch (error) {
    console.error("Admin verify KYC error:", error);
    res.status(500).json({
      success: false,
      message: "Error verifying KYC",
      error: error.message,
    });
  }
};

// =============================================================================
// PRIVATE HELPERS
// =============================================================================

/**
 * Apply pipeline results to a KYC document and save it.
 * Extracts top-level convenience fields (faceScore, ocrData, documentAuthentic,
 * riskScore) from the pipeline stages so existing code paths keep working.
 *
 * @param {Object} kyc            Mongoose KYC document (will be mutated & saved)
 * @param {Object} pipelineResult Full pipeline response from the AI service
 */
async function _applyPipelineResults(kyc, pipelineResult) {
  const stages = pipelineResult.stages || {};

  // ── Stage 2: OCR data ──
  const ocrStage = stages.stage2_ocr;
  if (ocrStage && ocrStage.extractedData) {
    kyc.ocrData = ocrStage.extractedData;
  }

  // ── Stage 3: Face similarity ──
  const faceStage = stages.stage3_face;
  if (faceStage) {
    kyc.faceScore = faceStage.similarityScore || 0;
  }

  // ── Stage 1: Document authenticity (derived from clarity check) ──
  const clarityStage = stages.stage1_clarity;
  if (clarityStage) {
    kyc.documentAuthentic = clarityStage.document?.passed || false;
  }

  // ── Stage 4: Risk score ──
  const riskStage = stages.stage4_risk;
  if (riskStage) {
    kyc.riskScore = riskStage.riskScore || 0;
  }

  // ── Full pipeline snapshot (for audit) ──
  kyc.pipelineResults = {
    pipelineVersion: pipelineResult.pipelineVersion,
    pipelineRunAt: new Date(),
    finalDecision: pipelineResult.finalDecision,
    abortedAt: pipelineResult.abortedAt || null,
    abortReason: pipelineResult.abortReason || null,
    stage1_clarity: stages.stage1_clarity || null,
    stage2_ocr: stages.stage2_ocr || null,
    stage3_face: stages.stage3_face || null,
    stage4_risk: stages.stage4_risk || null,
  };

  // ── Determine final verification status ──
  const decision = pipelineResult.finalDecision;
  if (decision === "approved") {
    kyc.verificationStatus = "approved";
    kyc.verifiedAt = new Date();
    kyc.rejectionReason = undefined;
    // Update user's isVerified field to true
    const user = await User.findById(kyc.userId);
    if (user) {
      user.isVerified = true;
      user.verifiedAt = new Date();
      await user.save();
    }
  } else if (decision === "under_review") {
    kyc.verificationStatus = "under_review";
  } else {
    kyc.verificationStatus = "rejected";
    const riskLevel = riskStage?.riskLevel || "high";
    const abortReason = pipelineResult.abortReason;
    kyc.rejectionReason =
      abortReason ||
      `Risk score ${kyc.riskScore}/100 (${riskLevel} risk). ` +
      `Face similarity: ${kyc.faceScore}%. ` +
      `Document authentic: ${kyc.documentAuthentic}.`;
    // Update user's isVerified field to false
    const user = await User.findById(kyc.userId);
    if (user) {
      user.isVerified = false;
      user.verifiedAt = undefined;
      await user.save();
    }
  }

  await kyc.save();
}

/**
 * Remove temp files that were downloaded (not original local paths).
 * @param {string[]} paths    Array of file paths to consider
 * @param {string}   tempDir  Only files inside this directory are removed
 */
function _cleanupTemp(paths, tempDir) {
  for (const p of paths) {
    try {
      if (p && p.includes(tempDir) && fs.existsSync(p)) {
        fs.unlinkSync(p);
      }
    } catch (_) {
      // ignore cleanup errors
    }
  }
}

// ── Pipeline Verify (Proxy to AI Service) ─────────────────────────────────
export const pipelineVerify = async (req, res) => {
  try {
    const userId = req.user.userId;

    // Find KYC record for the user
    const kyc = await KYC.findOne({ userId });
    if (!kyc) {
      return res.status(404).json({
        success: false,
        message: "KYC record not found",
      });
    }

    if (!kyc.documentImage || !kyc.selfie) {
      return res.status(400).json({
        success: false,
        message: "Both document and selfie must be uploaded before verification",
      });
    }

    // Create temp directory for downloaded images
    const tempDir = path.join(__dirname, "../../temp");
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    let documentPath, selfiePath;

    // Helper to download image from URL or use local file path
    const downloadImage = async (imageUrl, fileName) => {
      // Check if it's a local file path (Windows or Unix)
      if (imageUrl.match(/^[A-Za-z]:\\/) || imageUrl.startsWith('/')) {
        if (!fs.existsSync(imageUrl)) {
          throw new Error(`Local file not found: ${imageUrl}`);
        }
        return imageUrl; // Return the local path directly
      }

      // Otherwise, download from URL
      const downloadPath = path.join(tempDir, fileName);
      const response = await axios({ method: "get", url: imageUrl, responseType: "stream" });
      const writer = fs.createWriteStream(downloadPath);
      response.data.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
      });
      return downloadPath;
    };

    try {
      // Download images from Cloudinary
      documentPath = await downloadImage(
        kyc.documentImage,
        `doc_${userId}_${Date.now()}.jpg`
      );
      selfiePath = await downloadImage(
        kyc.selfie,
        `selfie_${userId}_${Date.now()}.jpg`
      );

      // Send to AI service
      const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:5002';
      const formData = new FormData();
      formData.append('document', fs.createReadStream(documentPath));
      formData.append('selfie', fs.createReadStream(selfiePath));

      const response = await axios.post(
        `${AI_SERVICE_URL}/pipeline/verify`,
        formData,
        {
          headers: formData.getHeaders(),
          timeout: 300000, // 5 minutes
        }
      );

      // Clean up temp files (only delete downloaded files, not original local files)
      try {
        if (documentPath.startsWith(tempDir)) {
          fs.unlinkSync(documentPath);
        }
        if (selfiePath.startsWith(tempDir)) {
          fs.unlinkSync(selfiePath);
        }
      } catch (cleanupError) {
        console.error("Cleanup error:", cleanupError);
      }

      // Update KYC record with pipeline results
      await _applyPipelineResults(kyc, response.data);

      return res.status(response.status).json(response.data);
    } catch (processingError) {
      // Clean up temp files on error
      try {
        if (documentPath && fs.existsSync(documentPath)) fs.unlinkSync(documentPath);
        if (selfiePath && fs.existsSync(selfiePath)) fs.unlinkSync(selfiePath);
      } catch (cleanupError) {
        console.error("Cleanup error:", cleanupError);
      }
      throw processingError;
    }
  } catch (error) {
    console.error("Pipeline verify error:", error);
    
    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }
    
    return res.status(500).json({
      success: false,
      message: "Error running pipeline verification",
      error: error.message,
    });
  }
};
