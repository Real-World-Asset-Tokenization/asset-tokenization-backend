import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure upload directory exists
const uploadDir = path.join(__dirname, "../../uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Storage configuration - temporary local storage before Cloudinary upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

// File filter
const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|pdf/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);

  if (extname && mimetype) {
    cb(null, true);
  } else {
    cb(new Error("Only JPEG, JPG, PNG, and PDF files are allowed"));
  }
};

// Multer configuration
const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter,
});

/**
 * Middleware to upload file to Cloudinary after multer upload
 * @param {string} folder - Cloudinary folder name
 * @returns {Function} Express middleware
 */
const uploadToCloudinaryMiddleware = (folder = 'kyc-documents') => {
  return async (req, res, next) => {
    try {
      // For now, just use local file paths
      // Cloudinary integration can be added later if needed
      next();
    } catch (error) {
      console.error('Upload middleware error:', error);
      return res.status(500).json({
        success: false,
        message: 'Error uploading files',
        error: error.message,
      });
    }
  };
};

export {
  upload,
  uploadToCloudinaryMiddleware,
};