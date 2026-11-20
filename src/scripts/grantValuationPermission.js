// Grants or revokes valuation permissions. Run by an operator; not exposed over HTTP.
//
//   npm run valuation:grant -- valuer@example.com PROPOSE
//   npm run valuation:grant -- approver@example.com APPROVE
//   npm run valuation:grant -- someone@example.com BOTH
//   npm run valuation:grant -- someone@example.com APPROVE --revoke
//   npm run valuation:grant -- --list
import "dotenv/config";
import mongoose from "mongoose";
import User from "../models/User.js";

const MAP = { PROPOSE: ["VALUATION_PROPOSE"], APPROVE: ["VALUATION_APPROVE"], BOTH: ["VALUATION_PROPOSE", "VALUATION_APPROVE"] };

const [email, which, flag] = process.argv.slice(2);
await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
try {
  if (email === "--list") {
    const users = await User.find({ permissions: { $exists: true, $ne: [] } }).lean();
    if (!users.length) console.log("No users have valuation permissions.");
    for (const u of users) console.log(`${u.email} (${u.role}): ${u.permissions.join(", ")}`);
  } else {
    const perms = MAP[String(which || "").toUpperCase()];
    if (!email || !perms) throw new Error("Usage: npm run valuation:grant -- <email> <PROPOSE|APPROVE|BOTH> [--revoke]");
    const update = flag === "--revoke" ? { $pullAll: { permissions: perms } } : { $addToSet: { permissions: { $each: perms } } };
    const user = await User.findOneAndUpdate({ email: email.toLowerCase() }, update, { new: true }).lean();
    if (!user) throw new Error(`No user with email ${email}`);
    console.log(`${user.email} (${user.role}) now has: ${user.permissions.join(", ") || "no valuation permissions"}`);
    console.log("The user may need to refresh the page; no new login is required.");
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
