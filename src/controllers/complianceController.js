import Compliance from "../models/Compliance.js";
import User from "../models/User.js";
import KYC from "../models/KYC.js";
import Asset from "../models/Asset.js";

// Run Compliance Check
export const runComplianceCheck = async (req, res) => {
  try {
    const userId = req.user.userId;

    // Get user's KYC and Asset data
    const kyc = await KYC.findOne({ userId });
    const assets = await Asset.find({ ownerId: userId });
    const user = await User.findById(userId);

    if (!kyc) {
      return res.status(400).json({
        success: false,
        message: "KYC record not found. Please complete KYC first.",
      });
    }

    // Check if compliance record already exists
    let compliance = await Compliance.findOne({ userId });
    if (!compliance) {
      compliance = new Compliance({ userId });
    }

    // Initialize risk score
    let riskScore = 0;
    const riskFactors = [];

    // 1. Identity Verification Check (30 points)
    if (kyc.verificationStatus === "approved") {
      riskScore += 30;
      compliance.identityVerified = true;
    } else {
      riskFactors.push("Identity not verified");
    }

    // 2. Document Authenticity Check (25 points)
    if (kyc.documentAuthentic) {
      riskScore += 25;
      compliance.documentAuthentic = true;
    } else {
      riskFactors.push("Document authenticity not confirmed");
    }

    // 3. Face Match Score Check (25 points)
    if (kyc.faceScore >= 90) {
      riskScore += 25;
      compliance.faceMatchScore = kyc.faceScore;
    } else if (kyc.faceScore >= 80) {
      riskScore += 20;
      compliance.faceMatchScore = kyc.faceScore;
      riskFactors.push("Face match score below optimal threshold");
    } else if (kyc.faceScore >= 70) {
      riskScore += 15;
      compliance.faceMatchScore = kyc.faceScore;
      riskFactors.push("Face match score low");
    } else {
      riskFactors.push("Face match score too low");
    }

    // 4. Duplicate User Detection (10 points)
    const duplicateUsers = await User.find({
      email: { $ne: user.email },
      name: user.name,
    });
    if (duplicateUsers.length > 0) {
      compliance.duplicateUserDetected = true;
      riskFactors.push("Potential duplicate user detected");
    } else {
      riskScore += 10;
    }

    // 5. Duplicate Asset Detection (10 points)
    const allAssets = await Asset.find({});
    const duplicateAssets = allAssets.filter(asset => {
      if (asset.ocrData && asset.ocrData.registrationNumber) {
        return assets.some(userAsset => 
          userAsset.ocrData && 
          userAsset.ocrData.registrationNumber === asset.ocrData.registrationNumber &&
          userAsset._id.toString() !== asset._id.toString()
        );
      }
      return false;
    });
    if (duplicateAssets.length > 0) {
      compliance.duplicateAssetDetected = true;
      riskFactors.push("Potential duplicate asset detected");
    } else {
      riskScore += 10;
    }

    // 6. Basic AML Check (simulated)
    // In production, this would integrate with external AML databases
    const amlKeywords = ["sanctioned", "blacklist", "watchlist"];
    const userNameLower = user.name.toLowerCase();
    const isFlagged = amlKeywords.some(keyword => userNameLower.includes(keyword));
    
    if (isFlagged) {
      compliance.amlStatus = "flagged";
      riskFactors.push("AML check flagged");
    } else {
      compliance.amlStatus = "cleared";
    }

    // Update compliance record
    compliance.riskScore = riskScore;
    compliance.riskFactors = riskFactors;

    // Determine approval status
    if (riskScore >= 80 && compliance.amlStatus === "cleared" && !compliance.duplicateUserDetected && !compliance.duplicateAssetDetected) {
      compliance.approvalStatus = "approved";
    } else if (riskScore >= 60) {
      compliance.approvalStatus = "manual_review";
    } else {
      compliance.approvalStatus = "rejected";
    }

    await compliance.save();

    res.status(200).json({
      success: true,
      message: "Compliance check completed",
      data: {
        complianceId: compliance._id,
        riskScore: compliance.riskScore,
        amlStatus: compliance.amlStatus,
        duplicateUserDetected: compliance.duplicateUserDetected,
        duplicateAssetDetected: compliance.duplicateAssetDetected,
        identityVerified: compliance.identityVerified,
        documentAuthentic: compliance.documentAuthentic,
        faceMatchScore: compliance.faceMatchScore,
        approvalStatus: compliance.approvalStatus,
        riskFactors: compliance.riskFactors,
      },
    });
  } catch (error) {
    console.error("Compliance check error:", error);
    res.status(500).json({
      success: false,
      message: "Error running compliance check",
      error: error.message,
    });
  }
};

// Get Compliance Report
export const getComplianceReport = async (req, res) => {
  try {
    const userId = req.user.userId;

    const compliance = await Compliance.findOne({ userId }).populate("userId", "name email role");
    if (!compliance) {
      return res.status(404).json({
        success: false,
        message: "Compliance record not found. Run compliance check first.",
      });
    }

    // Get related KYC and Asset data
    const kyc = await KYC.findOne({ userId });
    const assets = await Asset.find({ ownerId: userId });

    res.status(200).json({
      success: true,
      data: {
        compliance: {
          complianceId: compliance._id,
          riskScore: compliance.riskScore,
          amlStatus: compliance.amlStatus,
          duplicateUserDetected: compliance.duplicateUserDetected,
          duplicateAssetDetected: compliance.duplicateAssetDetected,
          identityVerified: compliance.identityVerified,
          documentAuthentic: compliance.documentAuthentic,
          faceMatchScore: compliance.faceMatchScore,
          approvalStatus: compliance.approvalStatus,
          riskFactors: compliance.riskFactors,
          notes: compliance.notes,
          reviewedBy: compliance.reviewedBy,
          reviewedAt: compliance.reviewedAt,
          createdAt: compliance.createdAt,
          updatedAt: compliance.updatedAt,
        },
        kycStatus: kyc ? kyc.verificationStatus : "not_started",
        assetCount: assets.length,
        verifiedAssets: assets.filter(a => a.verificationStatus === "approved").length,
      },
    });
  } catch (error) {
    console.error("Get compliance report error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching compliance report",
      error: error.message,
    });
  }
};

// Manual Review (Admin/Compliance Officer only)
export const manualReview = async (req, res) => {
  try {
    const { userId } = req.params;
    const { approvalStatus, notes } = req.body;
    const reviewerId = req.user.userId;

    // Check if requester is admin or compliance officer
    const reviewer = await User.findById(reviewerId);
    if (reviewer.role !== "admin" && reviewer.role !== "compliance_officer") {
      return res.status(403).json({
        success: false,
        message: "Only admins and compliance officers can perform manual reviews",
      });
    }

    const compliance = await Compliance.findOne({ userId });
    if (!compliance) {
      return res.status(404).json({
        success: false,
        message: "Compliance record not found",
      });
    }

    // Update compliance record
    compliance.approvalStatus = approvalStatus;
    compliance.notes = notes;
    compliance.reviewedBy = reviewerId;
    compliance.reviewedAt = Date.now();
    await compliance.save();

    res.status(200).json({
      success: true,
      message: "Manual review completed",
      data: {
        complianceId: compliance._id,
        approvalStatus: compliance.approvalStatus,
        notes: compliance.notes,
        reviewedAt: compliance.reviewedAt,
      },
    });
  } catch (error) {
    console.error("Manual review error:", error);
    res.status(500).json({
      success: false,
      message: "Error performing manual review",
      error: error.message,
    });
  }
};

// Get All Compliance Records (Admin only)
export const getAllComplianceRecords = async (req, res) => {
  try {
    const adminId = req.user.userId;

    // Check if requester is admin
    const admin = await User.findById(adminId);
    if (admin.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Only admins can view all compliance records",
      });
    }

    const records = await Compliance.find({})
      .populate("userId", "name email role")
      .populate("reviewedBy", "name")
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      data: {
        records: records.map(record => ({
          complianceId: record._id,
          user: {
            id: record.userId._id,
            name: record.userId.name,
            email: record.userId.email,
            role: record.userId.role,
          },
          riskScore: record.riskScore,
          amlStatus: record.amlStatus,
          approvalStatus: record.approvalStatus,
          duplicateUserDetected: record.duplicateUserDetected,
          duplicateAssetDetected: record.duplicateAssetDetected,
          reviewedBy: record.reviewedBy ? record.reviewedBy.name : null,
          reviewedAt: record.reviewedAt,
          createdAt: record.createdAt,
        })),
        count: records.length,
      },
    });
  } catch (error) {
    console.error("Get all compliance records error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching compliance records",
      error: error.message,
    });
  }
};