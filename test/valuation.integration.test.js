// End-to-end test of: manual proposal -> approval -> blockchain publication -> reference price.
//
//   npm run test:valuation
//
// Uses its own Hardhat node (port 8546) with freshly deployed contracts and an in-memory
// MongoDB, so it never touches the demo chain on 8545 or the Azure database.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import valuationRoutes from "../src/routes/valuationRoutes.js";
import User from "../src/models/User.js";
import PropertyValuation from "../src/models/PropertyValuation.js";
import ValuationAuditLog from "../src/models/ValuationAuditLog.js";
import { configure } from "../src/services/valuation/blockchainValuationService.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RPC = "http://127.0.0.1:8546";
// Standard Hardhat accounts (public test keys).
const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  investor: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  buyer: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  notPublisher: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
};
const day = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * day).toISOString();

let node, mongo, server, base, provider, wallets, c, contractsCfg;
const tokens = {};

const artifact = (name) => JSON.parse(fs.readFileSync(path.join(root, `blockchain/artifacts/contracts/${name}.sol/${name}.json`), "utf8"));
async function deploy(name, signer, ...args) {
  const a = artifact(name);
  const contract = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
  await contract.waitForDeployment();
  contractsCfg[name] = { address: await contract.getAddress(), abi: a.abi };
  return contract;
}

async function api(method, url, { as, body, form } = {}) {
  const headers = {};
  if (as) headers.Authorization = `Bearer ${tokens[as]}`;
  let payload;
  if (form) {
    payload = new FormData();
    for (const [k, v] of Object.entries(form)) payload.append(k, v);
  } else if (body) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + url, { method, headers, body: payload });
  return { status: res.status, body: await res.json() };
}

const propose = (value, effective, extra = {}) => api("POST", "/api/valuations/proposals", {
  as: "valuer",
  form: { assetId: "1", proposedValuation: value, effectiveDate: effective, reason: "Annual independent valuation by certified valuer", documentReference: `VAL-${value}`, ...extra },
});
const onChainValuation = async () => (await c.registry.getAsset(1)).valuationLKR;

before(async () => {
  // 1. Private Hardhat node
  node = spawn("npx", ["hardhat", "node", "--port", "8546"], { cwd: path.join(root, "blockchain"), shell: true });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Hardhat node did not start")), 90000);
    node.stdout.on("data", (d) => { if (String(d).includes("Started HTTP")) { clearTimeout(t); resolve(); } });
    node.on("exit", (code) => reject(new Error(`Hardhat node exited (${code}). Is port 8546 free?`)));
  });
  provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true, cacheTimeout: -1 });
  wallets = Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, new ethers.Wallet(v, provider)]));
  const d = wallets.deployer;

  // 2. Contracts: Colombo Oceanfront Residence, LKR 10,000,000, 1,000 tokens
  contractsCfg = {};
  const registry = await deploy("AssetRegistry", d);
  const token = await deploy("AssetToken", d, contractsCfg.AssetRegistry.address);
  await (await registry.setAssetTokenContract(contractsCfg.AssetToken.address)).wait();
  const musd = await deploy("MockPaymentToken", d, "Mock USD", "mUSD", 6);
  const market = await deploy("TokenMarketplace", d, contractsCfg.AssetToken.address, await d.getAddress(), 100);
  const vr = await deploy("AssetValuationRegistry", d, contractsCfg.AssetRegistry.address, contractsCfg.AssetToken.address, await d.getAddress());
  await (await registry.setAuthorizedVerifier(contractsCfg.AssetValuationRegistry.address, true)).wait();
  await (await registry.registerAsset("Colombo Oceanfront Residence", "COR-01", "ipfs://x", "0xdeed", 10_000_000n, 1000n)).wait();
  await (await registry.approveAsset(1)).wait();
  await (await token.tokenizeAsset(1, await d.getAddress())).wait();
  await (await token.safeTransferFrom(await d.getAddress(), await wallets.investor.getAddress(), 1, 300n, "0x")).wait();
  c = { registry, token, musd, market, vr };
  configure({ rpcUrl: RPC, privateKey: KEYS.deployer, contracts: contractsCfg });

  // 3. In-memory MongoDB + users
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  process.env.JWT_SECRET = "valuation-test-secret";
  process.env.VALUATION_ALLOW_SELF_APPROVAL = "false";
  const make = async (key, role, permissions, wallet) => {
    const u = await User.create({ name: key, email: `${key}@test.lk`, password: "secret123", role, permissions, walletAddress: wallet });
    tokens[key] = jwt.sign({ userId: String(u._id), role }, process.env.JWT_SECRET);
  };
  await make("valuer", "compliance_officer", ["VALUATION_PROPOSE"]);
  await make("approver", "admin", ["VALUATION_APPROVE"]);
  await make("solo", "admin", ["VALUATION_PROPOSE", "VALUATION_APPROVE"]);
  await make("investor", "investor", [], (await wallets.investor.getAddress()).toLowerCase());
  await make("owner", "asset_owner", [], (await d.getAddress()).toLowerCase());

  // 4. API
  const app = express();
  app.use(express.json());
  app.use("/api/valuations", valuationRoutes);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await mongoose.disconnect().catch(() => {});
  await mongo?.stop();
  provider?.destroy();
  if (node?.pid) {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(node.pid), "/T", "/F"]);
    else node.kill("SIGTERM");
  }
});

describe("Manual revaluation workflow", () => {
  let first;

  it("Test 1: 10M -> 12M approved and published; price 10,000 -> 12,000; supply and balances unchanged", async () => {
    const before = await api("GET", "/api/valuations/assets/1");
    assert.equal(before.body.data.referencePrice, "10000.00");

    const sub = await propose("12,000,000", daysAgo(10));
    assert.equal(sub.status, 201, JSON.stringify(sub.body));
    first = sub.body.data;
    assert.equal(first.status, "PENDING_APPROVAL");
    assert.equal(first.proposedReferencePrice, "12000.00");
    assert.equal(first.valuationChangePercent, "20.00");
    assert.equal(first.source, "MANUAL");

    // Not official before approval + publication.
    assert.equal((await api("GET", "/api/valuations/assets/1")).body.data.referencePrice, "10000.00");
    assert.equal(await onChainValuation(), 10_000_000n);

    const dup = await propose("12500000", daysAgo(9));
    assert.equal(dup.status, 409, "second open proposal for same asset is refused");

    const ok = await api("POST", `/api/valuations/proposals/${first.id}/approve`, { as: "approver" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.status, "PUBLISHED");
    assert.equal(ok.body.data.blockchainPublicationStatus, "CONFIRMED");
    assert.equal(ok.body.data.valuationVersion, 1);
    assert.match(String(ok.body.data.blockchainTransactionHash), /^0x[0-9a-f]{64}$/);

    const after = (await api("GET", "/api/valuations/assets/1")).body.data;
    assert.equal(after.approvedValuation, "12000000");
    assert.equal(after.referencePrice, "12000.00");
    assert.equal(after.previousReferencePrice, "10000.00");
    assert.equal(after.referencePriceChangePercent, "20.00");
    assert.equal(after.tokenSupply, "1000");
    assert.equal(await onChainValuation(), 12_000_000n);
    assert.equal(await c.token.totalShares(1), 1000n);
    assert.equal(await c.token.balanceOf(await wallets.investor.getAddress(), 1), 300n);
    assert.equal(await c.token.balanceOf(await wallets.deployer.getAddress(), 1), 700n);

    const saved = await PropertyValuation.findById(first.id).lean();
    assert.equal(saved.approvedValue, "12000000");
    assert.equal(saved.approvedReferencePriceCents, "1200000");
    assert.equal(saved.previousApprovedValue, "10000000");
    const actions = (await ValuationAuditLog.find({ proposalId: first.id }).lean()).map((l) => l.action);
    assert.deepEqual(actions, ["SUBMITTED", "APPROVED", "PUBLICATION_STARTED", "PUBLISHED"]);
  });

  it("Test 2: rejected proposal leaves Azure and blockchain values unchanged", async () => {
    const sub = await propose("15000000", daysAgo(8));
    const rej = await api("POST", `/api/valuations/proposals/${sub.body.data.id}/reject`, { as: "approver", body: { reason: "Comparable sales do not support this value" } });
    assert.equal(rej.body.data.status, "REJECTED");
    assert.equal(await onChainValuation(), 12_000_000n);
    assert.equal((await api("GET", "/api/valuations/assets/1")).body.data.referencePrice, "12000.00");
    const again = await api("POST", `/api/valuations/proposals/${sub.body.data.id}/approve`, { as: "approver" });
    assert.equal(again.status, 409, "a rejected proposal cannot be approved later");
  });

  it("Test 3: investors, owners and proposers cannot set or approve values", async () => {
    const asInvestor = await api("POST", "/api/valuations/proposals", { as: "investor", form: { assetId: "1", proposedValuation: "99000000", effectiveDate: daysAgo(1), reason: "I would like a higher value", documentReference: "x" } });
    assert.equal(asInvestor.status, 403);
    assert.equal((await api("POST", "/api/valuations/proposals", { form: { assetId: "1" } })).status, 401);

    const sub = await propose("11000000", daysAgo(7));
    assert.equal((await api("POST", `/api/valuations/proposals/${sub.body.data.id}/approve`, { as: "investor" })).status, 403);
    assert.equal((await api("POST", `/api/valuations/proposals/${sub.body.data.id}/approve`, { as: "owner" })).status, 403);
    assert.equal((await api("POST", `/api/valuations/proposals/${sub.body.data.id}/approve`, { as: "valuer" })).status, 403, "proposer lacks approve permission");
    await api("POST", `/api/valuations/proposals/${sub.body.data.id}/reject`, { as: "approver", body: { reason: "test cleanup" } });

    // A user with both permissions still cannot approve their own proposal.
    const own = await api("POST", "/api/valuations/proposals", { as: "solo", form: { assetId: "1", proposedValuation: "11000000", effectiveDate: daysAgo(7), reason: "Self approval attempt test", documentReference: "SOLO-1" } });
    assert.equal((await api("POST", `/api/valuations/proposals/${own.body.data.id}/approve`, { as: "solo" })).status, 403);
    await api("POST", `/api/valuations/proposals/${own.body.data.id}/reject`, { as: "approver", body: { reason: "test cleanup" } });

    // Nobody but the publisher key can write on-chain.
    const direct = c.vr.connect(wallets.investor);
    await assert.rejects(direct.publishValuation(1, 2, 99_000_000n, ethers.encodeBytes32String("LKR"), 1, ethers.id("r"), ethers.id("p")));
    assert.equal(await onChainValuation(), 12_000_000n);
  });

  it("Test 4: decrease to 8M gives LKR 8,000 per token; supply and balances unchanged", async () => {
    const sub = await propose("8000000", daysAgo(6));
    const ok = await api("POST", `/api/valuations/proposals/${sub.body.data.id}/approve`, { as: "approver" });
    assert.equal(ok.body.data.status, "PUBLISHED", JSON.stringify(ok.body));
    const v = (await api("GET", "/api/valuations/assets/1/reference-price")).body.data;
    assert.equal(v.referencePrice, "8000.00");
    assert.equal(v.tokenSupply, "1000");
    assert.equal(v.valuationVersion, 2);
    assert.equal(await c.token.balanceOf(await wallets.investor.getAddress(), 1), 300n);
  });

  it("Test 5: last trade price stays independent of the reference price", async () => {
    // Investor sells 10 tokens at 50 mUSD each.
    const investor = wallets.investor, buyer = wallets.buyer;
    await (await c.token.connect(investor).setApprovalForAll(contractsCfg.TokenMarketplace.address, true)).wait();
    await (await c.market.connect(investor).createListing(1, 10, ethers.parseUnits("50", 6), contractsCfg.MockPaymentToken.address, 0)).wait();
    await (await c.musd.mint(await buyer.getAddress(), ethers.parseUnits("1000", 6))).wait();
    await (await c.musd.connect(buyer).approve(contractsCfg.TokenMarketplace.address, ethers.parseUnits("500", 6))).wait();
    await (await c.market.connect(buyer).buyListing(1)).wait();

    // An asking price that never traded must not count as a trade.
    await (await c.market.connect(investor).createListing(1, 5, ethers.parseUnits("90", 6), contractsCfg.MockPaymentToken.address, 0)).wait();

    const sub = await propose("12000000", daysAgo(4));
    await api("POST", `/api/valuations/proposals/${sub.body.data.id}/approve`, { as: "approver" });
    const v = (await api("GET", "/api/valuations/assets/1")).body.data;
    assert.equal(v.referencePrice, "12000.00");
    assert.equal(v.lastTrade.pricePerToken, "50.0");
    assert.equal(v.lastTrade.currency, "mUSD");
  });

  it("Test 6: every published version stays in history with approval and tx details", async () => {
    const h = (await api("GET", "/api/valuations/assets/1/history")).body.data;
    assert.deepEqual(h.entries.map((e) => e.version), [0, 1, 2, 3]);
    assert.deepEqual(h.entries.map((e) => e.approvedValue), ["10000000", "12000000", "8000000", "12000000"]);
    for (const e of h.entries.slice(1)) {
      assert.match(e.transactionHash, /^0x/);
      assert.equal(e.approvedBy, "approver");
      assert.equal(e.submittedBy, "valuer");
      assert.equal(e.verifiedOnChain, true);
      assert.equal(e.azureRecordMissing, false);
    }
    assert.equal(h.registryInSync, true);
    assert.equal((await PropertyValuation.find({ status: "PUBLISHED" })).length, 3);
  });

  it("Test 7: failed publication is not shown as published; retry is safe and never duplicates", async () => {
    // Publisher key without the on-chain role -> the transaction reverts.
    configure({ rpcUrl: RPC, privateKey: KEYS.notPublisher, contracts: contractsCfg });
    const sub = await propose("13000000", daysAgo(2));
    const res = await api("POST", `/api/valuations/proposals/${sub.body.data.id}/approve`, { as: "approver" });
    assert.equal(res.body.data.status, "APPROVED");
    assert.equal(res.body.data.blockchainPublicationStatus, "FAILED");
    assert.ok(res.body.data.publicationError);
    assert.equal((await api("GET", "/api/valuations/assets/1")).body.data.referencePrice, "12000.00", "not exposed as official");
    assert.equal(await c.vr.latestVersion(1), 3n);

    // Retry with the correct key publishes exactly once.
    configure({ rpcUrl: RPC, privateKey: KEYS.deployer, contracts: contractsCfg });
    const retry = await api("POST", `/api/valuations/proposals/${sub.body.data.id}/publish`, { as: "approver" });
    assert.equal(retry.body.data.status, "PUBLISHED", JSON.stringify(retry.body));
    assert.equal(retry.body.data.valuationVersion, 4);
    const again = await api("POST", `/api/valuations/proposals/${sub.body.data.id}/publish`, { as: "approver" });
    assert.equal(again.body.data.status, "PUBLISHED");
    assert.equal(await c.vr.latestVersion(1), 4n, "repeat publish does not create another version");
    assert.equal((await api("GET", "/api/valuations/assets/1")).body.data.referencePrice, "13000.00");

    // Two approvers clicking at once: only one approval wins.
    const race = await propose("12500000", daysAgo(1));
    const [r1, r2] = await Promise.all([
      api("POST", `/api/valuations/proposals/${race.body.data.id}/approve`, { as: "approver" }),
      api("POST", `/api/valuations/proposals/${race.body.data.id}/approve`, { as: "approver" }),
    ]);
    assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
    assert.equal(await c.vr.latestVersion(1), 5n);
  });

  it("Test 7b: tx mined but server crashed before saving -> retry reconciles from chain, no resend", async () => {
    configure({ rpcUrl: RPC, privateKey: KEYS.notPublisher, contracts: contractsCfg });
    const sub = await propose("12600000", new Date().toISOString());
    const res = await api("POST", `/api/valuations/proposals/${sub.body.data.id}/approve`, { as: "approver" });
    assert.equal(res.body.data.blockchainPublicationStatus, "FAILED");

    // The "lost" transaction: same version and references, mined directly.
    const doc = await PropertyValuation.findById(sub.body.data.id).lean();
    await (await c.vr.connect(wallets.deployer).publishValuation(
      1, doc.valuationVersion, BigInt(doc.approvedValue), ethers.encodeBytes32String("LKR"),
      Math.floor(new Date(doc.valuationEffectiveDate).getTime() / 1000), doc.reportHash, doc.proposalRef
    )).wait();

    configure({ rpcUrl: RPC, privateKey: KEYS.deployer, contracts: contractsCfg });
    const retry = await api("POST", `/api/valuations/proposals/${sub.body.data.id}/publish`, { as: "approver" });
    assert.equal(retry.body.data.status, "PUBLISHED");
    assert.equal(await c.vr.latestVersion(1), 6n);
    const actions = (await ValuationAuditLog.find({ proposalId: sub.body.data.id }).lean()).map((l) => l.action);
    assert.ok(actions.includes("RECONCILED_FROM_CHAIN"));
  });

  it("Asset owner can request a review but not change the value", async () => {
    const r = await api("POST", "/api/valuations/assets/1/review-requests", { as: "owner", body: { reason: "New highway access completed nearby" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await api("POST", "/api/valuations/assets/1/review-requests", { as: "investor", body: { reason: "Not my property at all" } })).status, 403);
    const list = await api("GET", "/api/valuations/review-requests", { as: "valuer" });
    assert.equal(list.body.data.length, 1);
  });
});
