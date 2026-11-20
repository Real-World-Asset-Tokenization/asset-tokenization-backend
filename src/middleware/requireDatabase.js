import { isDbConnected } from "../config/db.js";

export function requireDatabase(req, res, next) {
  if (isDbConnected()) return next();
  return res.status(503).json({
    success: false,
    code: "DATABASE_UNAVAILABLE",
    message: "Database unavailable. Account, KYC and private asset data require MongoDB. The server is retrying the connection; please try again shortly.",
  });
}
