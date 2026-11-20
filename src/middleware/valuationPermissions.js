import User from "../models/User.js";

// Loads the signed-in user fresh from the database on every request, so a revoked
// permission takes effect immediately (the JWT only carries id and role).
export async function loadUser(req, res, next) {
  try {
    const user = await User.findById(req.user.userId).lean();
    if (!user) return res.status(401).json({ success: false, message: "Account not found" });
    req.account = user;
    next();
  } catch (err) {
    next(err);
  }
}

export const hasPermission = (user, permission) => (user?.permissions || []).includes(permission);

export const requirePermission = (...permissions) => (req, res, next) => {
  if (permissions.some((p) => hasPermission(req.account, p))) return next();
  return res.status(403).json({
    success: false,
    code: "VALUATION_PERMISSION_REQUIRED",
    message: `This action needs the ${permissions.join(" or ")} permission. Ask an operator to grant it.`,
  });
};
