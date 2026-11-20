// Security configuration shared by the server and the auth layer.

export const isProduction = () => process.env.NODE_ENV === "production";

const MIN_JWT_SECRET_LENGTH = 32;
const WEAK_JWT_SECRETS = new Set(["secret", "changeme", "jwt_secret", "your_jwt_secret", "password", "test", "dev"]);

/**
 * Refuses to start in production with a missing or guessable JWT secret, and warns loudly otherwise.
 * A weak secret lets anyone forge a token with role "admin".
 */
export function assertSecureEnvironment() {
  const secret = process.env.JWT_SECRET || "";
  const weak = secret.length < MIN_JWT_SECRET_LENGTH || WEAK_JWT_SECRETS.has(secret.toLowerCase());

  if (weak) {
    const message =
      `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} random characters ` +
      `(generate one with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")`;
    if (isProduction()) throw new Error(message);
    console.warn(`[security] WARNING: ${message}`);
  }

  if (isProduction()) {
    if (!process.env.FRONTEND_URL) {
      throw new Error("FRONTEND_URL must be set in production so CORS can be restricted to it");
    }
    if (process.env.ENABLE_DEMO_ENDPOINTS === "true") {
      throw new Error("ENABLE_DEMO_ENDPOINTS must not be enabled in production");
    }
  }
}

/** Origins allowed to call the API with credentials. */
export function allowedOrigins() {
  const origins = new Set((process.env.FRONTEND_URL || "").split(",").map((o) => o.trim()).filter(Boolean));
  if (!isProduction()) {
    ["http://localhost:5173", "http://127.0.0.1:5173"].forEach((o) => origins.add(o));
  }
  return origins;
}

/**
 * Demo-only endpoints (faucet, direct custodial sale, swap) hand out funds or tokens from the platform
 * wallet without verifying payment. They exist for local demos and are off in production.
 */
export const demoEndpointsEnabled = () => !isProduction() && process.env.ENABLE_DEMO_ENDPOINTS !== "false";

export const requireDemoMode = (req, res, next) => {
  if (demoEndpointsEnabled()) return next();
  return res.status(403).json({
    success: false,
    message: "This demo endpoint is disabled. Use the marketplace (signed orders) to trade.",
  });
};

/** Request-supplied values must be plain strings before they reach a database query (NoSQL operator injection). */
export const asString = (value) => (typeof value === "string" ? value : value === undefined || value === null ? "" : String(value));

export const escapeRegex = (value) => asString(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
