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

// File filter. Both checks are anchored: an unanchored /png/ would also accept ".pngx" or "image/png-evil".
const ALLOWED_EXTENSIONS = /^\.(jpe?g|png|pdf)$/;
const ALLOWED_MIME_TYPES = /^(image\/(jpeg|png)|application\/pdf)$/;

const fileFilter = (req, file, cb) => {
  const extname = ALLOWED_EXTENSIONS.test(path.extname(file.originalname).toLowerCase());
  const mimetype = ALLOWED_MIME_TYPES.test(file.mimetype);

  if (extname && mimetype) {
    cb(null, true);
  } else {
    cb(new Error("Only JPEG, JPG, PNG, and PDF files are allowed"));
  }
};

// The extension and MIME type are chosen by the client. Check the real file signature too, so a script or
// HTML file cannot be uploaded by renaming it.
const SIGNATURES = [
  { type: "jpeg", test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: "png", test: (b) => b.length > 7 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: "pdf", test: (b) => b.length > 4 && b.subarray(0, 5).toString("latin1") === "%PDF-" },
];

const hasAllowedSignature = (filePath) => {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const head = Buffer.alloc(8);
    const read = fs.readSync(fd, head, 0, 8, 0);
    const bytes = head.subarray(0, read);
    return SIGNATURES.some((sig) => sig.test(bytes));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
};

const uploadedFiles = (req) => {
  const files = [];
  if (req.file) files.push(req.file);
  if (Array.isArray(req.files)) files.push(...req.files);
  else if (req.files) Object.values(req.files).forEach((list) => files.push(...list));
  return files;
};

/** Rejects (and deletes) any uploaded file whose content is not really a JPEG, PNG or PDF. */
const verifyUploadContents = (req, res, next) => {
  const files = uploadedFiles(req);
  if (files.every((f) => hasAllowedSignature(f.path))) return next();
  files.forEach((f) => fs.unlink(f.path, () => {}));
  return res.status(400).json({
    success: false,
    message: "The uploaded file content does not match an allowed type (JPEG, PNG or PDF)",
  });
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
  return (req, res, next) => {
    // Files are kept on local disk for now (Cloudinary upload can be added later); verify them first.
    verifyUploadContents(req, res, next);
  };
};

export {
  upload,
  verifyUploadContents,
  uploadToCloudinaryMiddleware,
};