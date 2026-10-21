import express from "express";
import { body, validationResult } from "express-validator";
import {
  register,
  login,
  getMe,
  verifyUser,
  getAllUsers,
  updateWallet,
  checkWallet,
} from "../controllers/authController.js";
import { protect } from "../middleware/auth.js";

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
const registerValidation = [
  body("name")
    .trim()
    .notEmpty()
    .withMessage("Name is required")
    .isLength({ min: 2 })
    .withMessage("Name must be at least 2 characters"),
  body("email")
    .trim()
    .notEmpty()
    .withMessage("Email is required")
    .isEmail()
    .withMessage("Please provide a valid email")
    .normalizeEmail(),
  body("password")
    .notEmpty()
    .withMessage("Password is required")
    .isLength({ min: 6 })
    .withMessage("Password must be at least 6 characters"),
  body("role")
    .optional()
    .isIn(["investor", "asset_owner", "admin", "compliance_officer"])
    .withMessage("Invalid role"),
  body("walletAddress")
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .matches(/^0x[a-fA-F0-9]{40}$/)
    .withMessage("Invalid Ethereum wallet address format"),
];

const updateWalletValidation = [
  body("walletAddress")
    .trim()
    .notEmpty()
    .withMessage("Wallet address is required")
    .matches(/^0x[a-fA-F0-9]{40}$/)
    .withMessage("Invalid Ethereum wallet address format"),
];

const loginValidation = [
  body("email")
    .trim()
    .notEmpty()
    .withMessage("Email is required")
    .isEmail()
    .withMessage("Please provide a valid email")
    .normalizeEmail(),
  body("password")
    .notEmpty()
    .withMessage("Password is required"),
];

// Routes
router.post("/register", registerValidation, validate, register);
router.post("/login", loginValidation, validate, login);
router.get("/me", protect, getMe);
router.post("/verify/:userId", protect, verifyUser);
router.get("/users", protect, getAllUsers);
router.put("/wallet", protect, updateWalletValidation, validate, updateWallet);
router.get("/wallet/check/:address", protect, checkWallet);

export default router;
