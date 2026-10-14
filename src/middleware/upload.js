const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { uploadToCloudinary } = require("../utils/cloudinaryUpload");

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
      // Handle single file upload (legacy support)
      if (req.file) {
        // Upload to Cloudinary
        const cloudinaryResult = await uploadToCloudinary(req.file.path, folder);

        // Replace file path with Cloudinary URL
        req.file.cloudinaryUrl = cloudinaryResult.secure_url;
        req.file.publicId = cloudinaryResult.public_id;
        req.file.path = cloudinaryResult.secure_url;
      }

      // Handle multiple file uploads
      if (req.files) {
        for (const fieldName in req.files) {
          const files = req.files[fieldName];
          if (files && files.length > 0) {
            // Upload each file to Cloudinary
            for (const file of files) {
              const cloudinaryResult = await uploadToCloudinary(file.path, folder);
              file.cloudinaryUrl = cloudinaryResult.secure_url;
              file.publicId = cloudinaryResult.public_id;
              file.path = cloudinaryResult.secure_url;
            }
          }
        }
      }

      next();
    } catch (error) {
      console.error('Cloudinary upload middleware error:', error);
      return res.status(500).json({
        success: false,
        message: 'Error uploading to Cloudinary',
        error: error.message,
      });
    }
  };
};

module.exports = {
  upload,
  uploadToCloudinaryMiddleware,
};