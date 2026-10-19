import User from "../models/User.js";
import jwt from "jsonwebtoken";

// Generate JWT Token
const generateToken = (userId, role) => {
  return jwt.sign(
    { userId, role },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
};

// Register User
export const register = async (req, res) => {
  try {
    const { name, email, password, role, walletAddress } = req.body;

    // Check if user already exists by email
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: "User with this email already exists",
      });
    }

    let normalizedWallet = null;
    if (walletAddress) {
      normalizedWallet = walletAddress.toLowerCase().trim();
      if (!/^0x[a-f0-9]{40}$/i.test(normalizedWallet)) {
        return res.status(400).json({
          success: false,
          message: "Invalid Ethereum wallet address format. Must be a valid 42-character hex address (0x...).",
        });
      }

      // Check if wallet address is already linked to another user
      const existingWalletUser = await User.findOne({ walletAddress: normalizedWallet });
      if (existingWalletUser) {
        return res.status(400).json({
          success: false,
          message: "This wallet address is already associated with another user account. The same wallet cannot be shared between different users.",
        });
      }
    }

    // Create new user
    const user = await User.create({
      name,
      email,
      password,
      role: role || "investor",
      ...(normalizedWallet ? { walletAddress: normalizedWallet } : {}),
    });

    // Generate token
    const token = generateToken(user._id, user.role);

    res.status(201).json({
      success: true,
      message: "User registered successfully",
      data: {
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          walletAddress: user.walletAddress || null,
        },
        token,
      },
    });
  } catch (error) {
    if (error.code === 11000 && error.keyPattern?.walletAddress) {
      return res.status(400).json({
        success: false,
        message: "This wallet address is already linked to another user account. The same wallet cannot be shared between different users.",
      });
    }
    console.error("Register error:", error);
    res.status(500).json({
      success: false,
      message: "Error registering user",
      error: error.message,
    });
  }
};

// Login User
export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Find user and include password for comparison
    const user = await User.findOne({ email }).select("+password");

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }

    // Check password
    const isPasswordValid = await user.comparePassword(password);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }

    // Generate token
    const token = generateToken(user._id, user.role);

    res.status(200).json({
      success: true,
      message: "Login successful",
      data: {
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          walletAddress: user.walletAddress || null,
        },
        token,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({
      success: false,
      message: "Error logging in",
      error: error.message,
    });
  }
};

// Get Current User (Protected Route)
export const getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
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
          isVerified: user.isVerified,
          walletAddress: user.walletAddress || null,
          createdAt: user.createdAt,
        },
      },
    });
  } catch (error) {
    console.error("Get me error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching user data",
      error: error.message,
    });
  }
};

// Verify User (Admin only)
export const verifyUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const adminId = req.user.userId;

    // Check if requester is admin
    const admin = await User.findById(adminId);
    if (admin.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Only admins can verify users",
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    if (user.isVerified) {
      return res.status(400).json({
        success: false,
        message: "User is already verified",
      });
    }

    // Verify user
    user.isVerified = true;
    user.verifiedBy = adminId;
    user.verifiedAt = Date.now();
    await user.save();

    res.status(200).json({
      success: true,
      message: "User verified successfully",
      data: {
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          isVerified: user.isVerified,
          verifiedAt: user.verifiedAt,
        },
      },
    });
  } catch (error) {
    console.error("Verify user error:", error);
    res.status(500).json({
      success: false,
      message: "Error verifying user",
      error: error.message,
    });
  }
};

// Get All Users (Admin and compliance officers)
export const getAllUsers = async (req, res) => {
  try {
    const adminId = req.user.userId;

    // Check if requester is admin or compliance officer
    const admin = await User.findById(adminId);
    if (admin.role !== "admin" && admin.role !== "compliance_officer") {
      return res.status(403).json({
        success: false,
        message: "Only admins and compliance officers can view all users",
      });
    }

    const users = await User.find({}).select("-password").sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      data: {
        users: users.map(user => ({
          _id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          isVerified: user.isVerified,
          verifiedAt: user.verifiedAt,
          createdAt: user.createdAt,
        })),
        count: users.length,
      },
    });
  } catch (error) {
    console.error("Get all users error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching users",
      error: error.message,
    });
  }
};

// Update User's Connected Wallet Address
export const updateWallet = async (req, res) => {
  try {
    const { walletAddress } = req.body;
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    if (!walletAddress || typeof walletAddress !== "string") {
      return res.status(400).json({
        success: false,
        message: "Wallet address is required",
      });
    }

    const normalizedWallet = walletAddress.toLowerCase().trim();

    // Validate 42-character Ethereum address format (0x + 40 hex chars)
    if (!/^0x[a-f0-9]{40}$/i.test(normalizedWallet)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Ethereum wallet address format. Must be a valid 42-character hex address (0x...).",
      });
    }

    // Uniqueness constraint: Ensure no other user has this wallet address
    const existingUser = await User.findOne({
      walletAddress: normalizedWallet,
      _id: { $ne: user._id },
    });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: "This wallet address is already associated with another user account. The same wallet cannot be shared between different users.",
      });
    }

    user.walletAddress = normalizedWallet;
    await user.save();

    res.status(200).json({
      success: true,
      message: "Wallet updated successfully",
      data: {
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          walletAddress: user.walletAddress,
        },
      },
    });
  } catch (error) {
    if (error.code === 11000 && error.keyPattern?.walletAddress) {
      return res.status(400).json({
        success: false,
        message: "This wallet address is already linked to another user account. The same wallet cannot be shared between different users.",
      });
    }
    console.error("Update wallet error:", error);
    res.status(500).json({
      success: false,
      message: "Error updating wallet",
      error: error.message,
    });
  }
};

