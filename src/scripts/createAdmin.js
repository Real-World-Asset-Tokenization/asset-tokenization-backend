// Creates (or resets the password of) an administrator account. Run by an operator; not exposed over HTTP.
//
//   npm run admin:create                               -> admin@assettoken.local with a random password
//   npm run admin:create -- boss@example.com "Name"    -> that email and name, random password
//   npm run admin:create -- boss@example.com "Name" 'MyPassw0rd!'   -> choose the password yourself
import "dotenv/config";
import crypto from "crypto";
import mongoose from "mongoose";
import User from "../models/User.js";

const [emailArg, nameArg, passwordArg] = process.argv.slice(2);
const email = (emailArg || "admin@assettoken.local").toLowerCase();
const name = nameArg || "Platform Admin";
const password = passwordArg || crypto.randomBytes(12).toString("base64url");

if (password.length < 6) {
  console.error("Password must be at least 6 characters");
  process.exit(1);
}

await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
try {
  let user = await User.findOne({ email });
  const existed = Boolean(user);
  if (!user) user = new User({ email });
  user.name = name;
  user.password = password; // hashed by the model's pre-save hook
  user.role = "admin";
  user.isVerified = true;
  user.verifiedAt = new Date();
  user.permissions = ["VALUATION_PROPOSE", "VALUATION_APPROVE"];
  await user.save();

  console.log(existed ? "Existing account promoted to admin and password reset." : "Admin account created.");
  console.log(`  Email:    ${email}`);
  console.log(`  Password: ${password}`);
  console.log("Store the password now; it is not saved anywhere in readable form.");
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
