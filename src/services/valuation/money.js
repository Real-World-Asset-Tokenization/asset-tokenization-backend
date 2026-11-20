// Integer-safe money helpers. Valuations are whole LKR; prices are LKR cents.
// Everything is BigInt internally and a decimal-digit string at the edges.

const MAX_VALUATION = 10n ** 15n; // LKR 1 quadrillion: far above any property, well inside uint256

export class MoneyError extends Error {}

// Accepts "12000000", "12,000,000", 12000000. Rejects decimals, signs, exponents and junk.
export function parseWholeLkr(input, label = "Valuation") {
  const text = String(input ?? "").replace(/[,\s]/g, "");
  if (!/^\d+$/.test(text)) throw new MoneyError(`${label} must be a whole number of LKR (no decimals or symbols)`);
  const value = BigInt(text);
  if (value <= 0n) throw new MoneyError(`${label} must be greater than zero`);
  if (value > MAX_VALUATION) throw new MoneyError(`${label} is unrealistically large`);
  return value;
}

export const toBig = (s) => BigInt(s);
export const toStr = (b) => BigInt(b).toString();

// Reference price = approved valuation / issued supply, in cents, rounded down.
export function referencePriceCents(valuation, supply) {
  const v = BigInt(valuation), n = BigInt(supply);
  if (n <= 0n) throw new MoneyError("Issued token supply must be greater than zero");
  return (v * 100n) / n;
}

// "1200000" cents -> "12000.00"
export function centsToDecimal(cents) {
  const c = BigInt(cents);
  const sign = c < 0n ? "-" : "";
  const a = c < 0n ? -c : c;
  return `${sign}${a / 100n}.${(a % 100n).toString().padStart(2, "0")}`;
}

// Percentage change with two decimals, e.g. (10M -> 12M) = "20.00", (10M -> 8M) = "-20.00".
export function percentChange(from, to) {
  const f = BigInt(from), t = BigInt(to);
  if (f === 0n) return null;
  const basisPoints = ((t - f) * 10000n) / f; // truncated toward zero
  return centsToDecimal(basisPoints);
}
