import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MODEL_ROOT = path.resolve(
  __dirname,
  "../../../AI-Supported-Investor-Decision-Support-System"
);

const PREDICT_SCRIPT = path.join(MODEL_ROOT, "ml", "serve", "predict_match.py");

const LOCATIONS = new Set(["colombo", "other_urban", "suburban_rural"]);
const TYPES = new Set(["residential", "commercial", "land"]);

function resolvePython() {
  if (process.env.PYTHON_PATH && fs.existsSync(process.env.PYTHON_PATH)) {
    return process.env.PYTHON_PATH;
  }
  const local = path.join(
    process.env.LOCALAPPDATA || "",
    "Programs",
    "Python",
    "Python312",
    "python.exe"
  );
  if (fs.existsSync(local)) {
    return local;
  }
  return "python";
}

function cleanPref(value, allowed) {
  if (value == null || value === "") {
    return "";
  }
  const tokens = String(value)
    .split("|")
    .map((token) => token.trim())
    .filter((token) => allowed.has(token));
  return [...new Set(tokens)].join("|");
}

export function readProfile(body) {
  const budget = Number(body?.budgetLkr);
  if (!Number.isFinite(budget) || budget <= 0 || budget > 50_000_000) {
    const error = new Error("Enter a budget in rupees between 1 and 50,000,000.");
    error.status = 400;
    throw error;
  }
  return {
    budgetLkr: budget,
    locPref: cleanPref(body?.locPref, LOCATIONS),
    typePref: cleanPref(body?.typePref, TYPES),
  };
}

export function scoreProfile(profile) {
  if (!fs.existsSync(PREDICT_SCRIPT)) {
    const error = new Error("The land-match script was not found.");
    error.status = 500;
    throw error;
  }

  const python = resolvePython();

  return new Promise((resolve, reject) => {
    const child = spawn(python, [PREDICT_SCRIPT], {
      cwd: MODEL_ROOT,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      const error = new Error("The land-match model took too long.");
      error.status = 504;
      reject(error);
    }, 120000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      err.status = 500;
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const error = new Error(
          stderr.trim().split("\n").slice(-3).join(" ") || "The land-match model failed."
        );
        error.status = 500;
        reject(error);
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        const error = new Error("The land-match model returned an unreadable result.");
        error.status = 500;
        reject(error);
      }
    });
    child.stdin.write(JSON.stringify(profile));
    child.stdin.end();
  });
}
