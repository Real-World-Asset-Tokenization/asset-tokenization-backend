// End-to-end test of signed marketplace orders and the full-property sale (escrow, signed votes
// relayed in one batch, snapshot payouts and claims) through the real API routes.
//
//   npm run test:sale
//
// Uses its own Hardhat node (port 8546) with freshly deployed contracts and an in-memory MongoDB,
// so it never touches the demo chain on 8545 or the Azure database.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import orderRoutes from "../src/routes/orderRoutes.js";
import saleRoutes from "../src/routes/saleRoutes.js";
import User from "../src/models/User.js";
import { SignedOrder } from "../src/models/SignedOrder.js";
import gasAnalyticsService from "../src/services/GasAnalyticsService.js";
import { estimateTokenizationFee } from "../src/services/verifiedAssetService.js";
import { ORDER_TYPES, FOLLOW_ORDER_TYPES, VOTE_TYPES } from "../src/services/chainContracts.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RPC = "http://127.0.0.1:8546";
// Standard Hardhat accounts (public test keys).
const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  holderA: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  holderB: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  holderC: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  holderD: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  buyer: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  stranger: "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  issuer: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356", // the property owner, not the platform
};
const ONE = 10n ** 6n;
const SALE_PRICE = 15_000_000n * ONE;

let node, mongo, server, base, provider, wallets, c, contractsCfg, chainId, contractsFile;
const tokens = {};

const artifact = (name) => JSON.parse(fs.readFileSync(path.join(root, `blockchain/artifacts/contracts/${name}.sol/${name}.json`), "utf8"));
async function deploy(name, signer, ...args) {
  const a = artifact(name);
  const contract = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
  await contract.waitForDeployment();
  contractsCfg[name] = { address: await contract.getAddress(), abi: a.abi };
  return contract;
}

async function api(method, url, { as, body } = {}) {
  const headers = {};
  if (as) headers.Authorization = `Bearer ${tokens[as]}`;
  let payload;
  if (body) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + url, { method, headers, body: payload });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  node = spawn("npx", ["hardhat", "node", "--port", "8546"], { cwd: path.join(root, "blockchain"), shell: true });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Hardhat node did not start")), 90000);
    node.stdout.on("data", (d) => { if (String(d).includes("Started HTTP")) { clearTimeout(t); resolve(); } });
    node.on("exit", (code) => reject(new Error(`Hardhat node exited (${code}). Is port 8546 free?`)));
  });
  provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true, cacheTimeout: -1 });
  wallets = Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, new ethers.Wallet(v, provider)]));
  chainId = Number((await provider.getNetwork()).chainId);
  const d = wallets.deployer;

  // Colombo land: 1,000 tokens, issued to the property owner (a different wallet from the platform).
  contractsCfg = {};
  const registry = await deploy("AssetRegistry", d);
  const token = await deploy("AssetToken", d, contractsCfg.AssetRegistry.address);
  await (await registry.setAssetTokenContract(contractsCfg.AssetToken.address)).wait();
  const musd = await deploy("MockPaymentToken", d, "Mock USD", "mUSD", 6);
  const market = await deploy("TokenMarketplace", d, contractsCfg.AssetToken.address, await d.getAddress(), 100);
  const sale = await deploy("PropertySale", d, contractsCfg.AssetToken.address);
  // Offers at the approved price read the published valuation; 100 LKR per USD keeps the numbers round.
  const valuation = await deploy("AssetValuationRegistry", d, contractsCfg.AssetRegistry.address, contractsCfg.AssetToken.address, await d.getAddress());
  await (await registry.setAuthorizedVerifier(contractsCfg.AssetValuationRegistry.address, true)).wait();
  await (await market.setValuationRegistry(contractsCfg.AssetValuationRegistry.address)).wait();
  await (await market.setLkrPerUsd(10000n)).wait();
  await (await token.setAuthorizedCaller(contractsCfg.PropertySale.address, true)).wait();
  await (await registry.connect(wallets.issuer).registerAsset("Colombo Land", "CLD", "ipfs://colombo", "0xdeed", 10_000_000n, 1000n)).wait();
  await (await registry.approveAsset(1)).wait();
  await (await token.tokenizeAsset(1, wallets.issuer.address)).wait();
  // A second, approved but not yet tokenized property, for the tokenization fee estimate.
  await (await registry.connect(wallets.issuer).registerAsset("Kandy Villa", "KDY", "ipfs://kandy", "0xdeed2", 5_000_000n, 500n)).wait();
  await (await registry.approveAsset(2)).wait();
  c = { registry, token, musd, market, sale, valuation };

  // Owner keeps 400; A 200, B 150, C 150, D 100.
  for (const [k, n] of [["holderA", 200n], ["holderB", 150n], ["holderC", 150n], ["holderD", 100n]]) {
    await (await token.connect(wallets.issuer).safeTransferFrom(wallets.issuer.address, wallets[k].address, 1, n, "0x")).wait();
  }
  for (const k of ["holderA", "buyer"]) await (await musd.mint(wallets[k].address, 100_000_000n * ONE)).wait();

  contractsFile = path.join(os.tmpdir(), `sale-test-contracts-${process.pid}.json`);
  fs.writeFileSync(contractsFile, JSON.stringify({ chainId, contracts: contractsCfg }));
  process.env.DEPLOYED_CONTRACTS_FILE = contractsFile;
  process.env.BLOCKCHAIN_RPC_URL = RPC;
  process.env.DEPLOYER_PRIVATE_KEY = KEYS.deployer;
  process.env.JWT_SECRET = "sale-test-secret";

  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const make = async (key, role, wallet) => {
    const u = await User.create({ name: key, email: `${key}@test.lk`, password: "secret123", role, walletAddress: wallet?.toLowerCase() });
    tokens[key] = jwt.sign({ userId: String(u._id), role }, process.env.JWT_SECRET);
  };
  await make("owner", "asset_owner", wallets.issuer.address);
  for (const k of ["holderA", "holderB", "holderC", "holderD", "buyer", "stranger"]) await make(k, "investor", wallets[k].address);
  await make("admin", "admin", null);

  const app = express();
  app.use(express.json());
  app.use("/api/orders", orderRoutes);
  app.use("/api/sales", saleRoutes);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await mongoose.disconnect().catch(() => {});
  await mongo?.stop();
  provider?.destroy();
  if (contractsFile) fs.rmSync(contractsFile, { force: true });
  if (node?.pid) {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(node.pid), "/T", "/F"]);
    else node.kill("SIGTERM");
  }
});

const orderDomain = () => ({ name: "TokenMarketplace", version: "1", chainId, verifyingContract: contractsCfg.TokenMarketplace.address });
const voteDomain = () => ({ name: "PropertySale", version: "1", chainId, verifyingContract: contractsCfg.PropertySale.address });

describe("Tokenization fee estimate", () => {
  it("reads the fee for an approved property from the chain, and gives nothing when it cannot", async () => {
    const fee = await estimateTokenizationFee(2, wallets.issuer.address);
    assert.ok(fee.gasUnits > 100_000 && fee.gasUnits < 400_000, `gas estimate ${fee.gasUnits}`);
    assert.ok(fee.gasPriceGwei > 0 && fee.feeEth > 0);
    // The estimate matches what tokenizing really uses, within a small margin.
    const receipt = await (await c.token.connect(wallets.issuer).tokenize(2)).wait();
    assert.ok(Math.abs(Number(receipt.gasUsed) - fee.gasUnits) / fee.gasUnits < 0.1, `estimate ${fee.gasUnits} vs used ${receipt.gasUsed}`);
    // Already tokenized: the call would revert, so there is no estimate rather than an invented one.
    assert.deepEqual(await estimateTokenizationFee(2, wallets.issuer.address), { gasUnits: null, gasPriceGwei: null, feeEth: null });
    assert.deepEqual(await estimateTokenizationFee(null, wallets.issuer.address), { gasUnits: null, gasPriceGwei: null, feeEth: null });
  });
});

describe("Signed marketplace orders", () => {
  let order, signature;

  it("owner signs an order off-chain and it appears in the order book without any listing transaction", async () => {
    await (await c.token.connect(wallets.issuer).setApprovalForAll(contractsCfg.TokenMarketplace.address, true)).wait();
    order = {
      seller: wallets.issuer.address, assetId: "1", amount: "100", pricePerToken: String(100n * ONE),
      paymentToken: contractsCfg.MockPaymentToken.address, expiry: "0", salt: "1",
    };
    signature = await wallets.issuer.signTypedData(orderDomain(), ORDER_TYPES, order);

    const res = await api("POST", "/api/orders", { as: "owner", body: { order, signature } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(await c.market.totalListings(), 0n, "no on-chain listing was created");

    const book = await api("GET", "/api/orders?assetId=1");
    assert.equal(book.body.count, 1);
    assert.equal(book.body.data[0].kind, "signed");
    assert.equal(book.body.data[0].amount, 100);
    assert.equal(book.body.data[0].pricePerTokenFormatted, 100);
  });

  it("refuses an order signed by someone else, or posted by a different account", async () => {
    const forged = await wallets.stranger.signTypedData(orderDomain(), ORDER_TYPES, order);
    assert.equal((await api("POST", "/api/orders", { as: "owner", body: { order: { ...order, salt: "2" }, signature: forged } })).status, 400);
    const sig2 = await wallets.issuer.signTypedData(orderDomain(), ORDER_TYPES, { ...order, salt: "3" });
    assert.equal((await api("POST", "/api/orders", { as: "stranger", body: { order: { ...order, salt: "3" }, signature: sig2 } })).status, 403);
    assert.equal((await api("GET", "/api/orders")).body.count, 1);
  });

  it("a buyer fills part of the order on-chain and the book shows what is left", async () => {
    await (await c.musd.connect(wallets.holderA).approve(contractsCfg.TokenMarketplace.address, ethers.MaxUint256)).wait();
    const typed = { ...order, assetId: 1n, amount: 100n, pricePerToken: 100n * ONE, expiry: 0n, salt: 1n };
    await (await c.market.connect(wallets.holderA).fillSignedOrder(typed, signature, 40n)).wait();
    // holderA already held 200 tokens; the order's 40 move from the owner
    assert.equal(await c.token.balanceOf(wallets.holderA.address, 1), 240n);
    const book = await api("GET", "/api/orders?assetId=1");
    assert.equal(book.body.data[0].amount, 60);
  });

  it("an investor resale is recorded and paid for by the buyer", async () => {
    const market = contractsCfg.TokenMarketplace.address;
    await (await c.musd.mint(wallets.holderB.address, 1_000_000n * ONE)).wait();
    await (await c.musd.connect(wallets.holderB).approve(market, ethers.MaxUint256)).wait();
    await (await c.token.connect(wallets.holderA).setApprovalForAll(market, true)).wait();
    await (await c.token.connect(wallets.holderB).setApprovalForAll(market, true)).wait();

    // A resells 10 tokens to B, then B sells the same 10 back, so later balances are unchanged.
    const resell = async (seller, buyerKey, sellerKey, salt) => {
      const o = { seller: seller.address, assetId: "1", amount: "10", pricePerToken: String(120n * ONE), paymentToken: contractsCfg.MockPaymentToken.address, expiry: "0", salt: String(salt) };
      const sig = await seller.signTypedData(orderDomain(), ORDER_TYPES, o);
      assert.equal((await api("POST", "/api/orders", { as: sellerKey, body: { order: o, signature: sig } })).status, 201);
      const typed = { ...o, assetId: 1n, amount: 10n, pricePerToken: 120n * ONE, expiry: 0n, salt: BigInt(salt) };
      await (await c.market.connect(wallets[buyerKey]).fillSignedOrder(typed, sig, 10n)).wait();
    };
    await resell(wallets.holderA, "holderB", "holderA", 11);
    await resell(wallets.holderB, "holderA", "holderB", 12);
    assert.equal(await c.token.balanceOf(wallets.holderA.address, 1), 240n);
    assert.equal(await c.token.balanceOf(wallets.holderB.address, 1), 150n);
  });

  it("a cancelled order disappears from the book", async () => {
    const typed = { ...order, assetId: 1n, amount: 100n, pricePerToken: 100n * ONE, expiry: 0n, salt: 1n };
    await (await c.market.cancelSignedOrder(typed)).wait();
    assert.equal((await api("GET", "/api/orders?assetId=1")).body.count, 0);
  });
});

describe("Offers at the approved price", () => {
  const follow = () => ({
    seller: wallets.issuer.address, assetId: "1", amount: "50", premiumBps: "0", floorPrice: "0",
    paymentToken: contractsCfg.MockPaymentToken.address, expiry: "0", salt: "10",
  });
  let signature;

  it("an offer with no fixed price is listed at the approved price", async () => {
    const order = follow();
    signature = await wallets.issuer.signTypedData(orderDomain(), FOLLOW_ORDER_TYPES, order);
    const res = await api("POST", "/api/orders", { as: "owner", body: { order, signature } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const book = await api("GET", "/api/orders?assetId=1");
    assert.equal(book.body.count, 1);
    assert.equal(book.body.data[0].follow, true);
    // 10,000,000 LKR over 1,000 tokens at 100 LKR per USD
    assert.equal(book.body.data[0].pricePerTokenFormatted, 100);
  });

  it("a forged signature, or a premium outside the range, is refused", async () => {
    const forged = await wallets.stranger.signTypedData(orderDomain(), FOLLOW_ORDER_TYPES, { ...follow(), salt: "11" });
    assert.equal((await api("POST", "/api/orders", { as: "owner", body: { order: { ...follow(), salt: "11" }, signature: forged } })).status, 400);
    const wild = { ...follow(), salt: "12", premiumBps: "20000" };
    const wildSig = await wallets.issuer.signTypedData(orderDomain(), FOLLOW_ORDER_TYPES, wild);
    assert.equal((await api("POST", "/api/orders", { as: "owner", body: { order: wild, signature: wildSig } })).status, 400);
  });

  it("the price rises by itself when the property is revalued, with no new signature", async () => {
    const stamp = BigInt((await provider.getBlock("latest")).timestamp);
    const hash = (x) => ethers.keccak256(ethers.toUtf8Bytes(x));
    await (await c.valuation.publishValuation(1, 1, 20_000_000n, ethers.encodeBytes32String("LKR"), stamp, hash("report"), hash("proposal"))).wait();
    const book = await api("GET", "/api/orders?assetId=1");
    assert.equal(book.body.data[0].pricePerTokenFormatted, 200);
  });

  it("a buyer who allows only the old price is protected from the new one", async () => {
    await (await c.musd.connect(wallets.holderA).approve(contractsCfg.TokenMarketplace.address, ethers.MaxUint256)).wait();
    const typed = { ...follow(), assetId: 1n, amount: 50n, premiumBps: 0n, floorPrice: 0n, expiry: 0n, salt: 10n };
    await assert.rejects(c.market.connect(wallets.holderA).fillFollowOrder(typed, signature, 10n, 100n * ONE), /Price above buyer limit/);
    assert.equal(await c.token.balanceOf(wallets.holderA.address, 1), 240n, "nothing was bought");
  });

  it("a cancelled offer disappears from the book", async () => {
    const typed = { ...follow(), assetId: 1n, amount: 50n, premiumBps: 0n, floorPrice: 0n, expiry: 0n, salt: 10n };
    await (await c.market.cancelFollowOrder(typed)).wait();
    assert.equal((await api("GET", "/api/orders?assetId=1")).body.count, 0);
  });
});

describe("Offers from an earlier marketplace", () => {
  const OLD = "0x0000000000000000000000000000000000000001";
  let hash;

  it("a seller's offers signed for the previous marketplace are listed so they can be signed again", async () => {
    // Pretend the current marketplace replaced an earlier one.
    fs.writeFileSync(contractsFile, JSON.stringify({ chainId, contracts: contractsCfg, previousTokenMarketplaces: [contractsCfg.TokenMarketplace.address] }));
    hash = ethers.id("old-order");
    await SignedOrder.create({
      orderHash: hash, seller: wallets.issuer.address.toLowerCase(), assetId: 1, amount: 80, pricePerToken: String(12n * ONE),
      paymentToken: contractsCfg.MockPaymentToken.address, salt: "99", signature: "0x00", status: "Active", marketplace: OLD,
    });
    const res = await api("GET", "/api/orders/stale", { as: "owner" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.count, 1);
    assert.equal(res.body.data[0].amount, 80);
    assert.equal(res.body.data[0].pricePerTokenFormatted, 12);
  });

  it("another seller sees none of them, and they are not in the order book", async () => {
    assert.equal((await api("GET", "/api/orders/stale", { as: "stranger" })).body.count, 0);
    assert.equal((await api("GET", "/api/orders?assetId=1")).body.count, 0);
  });

  it("once signed again and cancelled, the earlier offer is no longer listed", async () => {
    assert.equal((await api("POST", `/api/orders/${hash}/cancel`, { as: "owner" })).status, 200);
    assert.equal((await api("GET", "/api/orders/stale", { as: "owner" })).body.count, 0);
    fs.writeFileSync(contractsFile, JSON.stringify({ chainId, contracts: contractsCfg }));
  });
});

describe("Full-property sale", () => {
  const offerId = 1;
  const signVote = (key, support) => wallets[key].signTypedData(voteDomain(), VOTE_TYPES, { offerId, support });
  // After the order above: owner 360, A 240, B 150, C 150, D 100 (total 1,000).

  it("buyer escrows the price and the offer is listed as Pending", async () => {
    await (await c.musd.connect(wallets.buyer).approve(contractsCfg.PropertySale.address, SALE_PRICE)).wait();
    await (await c.sale.connect(wallets.buyer).createOffer(1, contractsCfg.MockPaymentToken.address, SALE_PRICE, 7 * 86400)).wait();
    const list = await api("GET", "/api/sales");
    assert.equal(list.body.count, 1);
    assert.equal(list.body.data[0].statusLabel, "Pending");
    assert.equal(list.body.data[0].price, 15_000_000);
    assert.equal(await c.musd.balanceOf(contractsCfg.PropertySale.address), SALE_PRICE);
  });

  it("only the admin can open voting, and opening it freezes token transfers", async () => {
    assert.equal((await api("POST", `/api/sales/${offerId}/open`, { as: "holderA" })).status, 403);
    const res = await api("POST", `/api/sales/${offerId}/open`, { as: "admin" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await api("GET", `/api/sales/${offerId}`)).body.data.statusLabel, "Voting");
    await assert.rejects(c.token.connect(wallets.holderB).safeTransferFrom(wallets.holderB.address, wallets.holderC.address, 1, 1n, "0x"), /Transfers locked/);
  });

  it("holders sign votes with no gas and the platform records them as pending", async () => {
    const ownerVote = await wallets.issuer.signTypedData(voteDomain(), VOTE_TYPES, { offerId, support: 1 });
    assert.equal((await api("POST", `/api/sales/${offerId}/votes`, { as: "owner", body: { support: 1, signature: ownerVote } })).status, 201);
    assert.equal((await api("POST", `/api/sales/${offerId}/votes`, { as: "holderA", body: { support: 1, signature: await signVote("holderA", 1) } })).status, 201);
    assert.equal((await api("POST", `/api/sales/${offerId}/votes`, { as: "holderD", body: { support: 2, signature: await signVote("holderD", 2) } })).status, 201);

    // The same wallet cannot vote twice, a stranger without tokens cannot vote, and a vote signed by another wallet is refused.
    assert.equal((await api("POST", `/api/sales/${offerId}/votes`, { as: "holderA", body: { support: 1, signature: await signVote("holderA", 1) } })).status, 400);
    assert.equal((await api("POST", `/api/sales/${offerId}/votes`, { as: "stranger", body: { support: 1, signature: await signVote("stranger", 1) } })).status, 400);
    assert.equal((await api("POST", `/api/sales/${offerId}/votes`, { as: "holderB", body: { support: 1, signature: await signVote("holderC", 1) } })).status, 403);

    const detail = await api("GET", `/api/sales/${offerId}?address=${wallets.holderA.address}`);
    assert.equal(detail.body.data.pendingSignedVotes, 3);
    assert.equal(detail.body.viewer.votingWeight, 240);
    assert.equal(detail.body.viewer.signedVote.support, 1);
  });

  it("the platform submits all pending votes in one transaction", async () => {
    const res = await api("POST", `/api/sales/${offerId}/relay-votes`, { as: "admin" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.relayed, 3);
    assert.equal(res.body.counted, 3);
    assert.equal(res.body.txHashes.length, 1);

    const offer = (await api("GET", `/api/sales/${offerId}`)).body.data;
    assert.equal(offer.yesVotes, 600); // owner 360 + A 240
    assert.equal(offer.noVotes, 100);
    assert.equal(offer.pendingSignedVotes, 0);
  });

  it("finalizes as Approved once yes votes pass half of ALL tokens", async () => {
    const res = await api("POST", `/api/sales/${offerId}/finalize`, { as: "admin" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, "Approved");
  });

  it("confirming the legal transfer publishes payouts for every holder, including the one who voted no", async () => {
    const res = await api("POST", `/api/sales/${offerId}/confirm`, { as: "admin" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.holders, 5);

    const payouts = {};
    for (const k of ["holderA", "holderB", "holderC", "holderD"]) {
      const p = await api("GET", `/api/sales/${offerId}/payout/${wallets[k].address}`);
      assert.equal(p.status, 200);
      payouts[k] = BigInt(p.body.data.amount);
    }
    const ownerPayout = BigInt((await api("GET", `/api/sales/${offerId}/payout/${wallets.issuer.address}`)).body.data.amount);
    assert.equal(payouts.holderD, (SALE_PRICE * 100n) / 1000n, "the holder who voted no is still paid by balance");
    assert.equal(ownerPayout + Object.values(payouts).reduce((a, b) => a + b, 0n), SALE_PRICE, "payouts add up to the escrowed price");
  });

  it("each holder claims on-chain with the proof from the API and receives exactly their share", async () => {
    for (const k of ["holderB", "holderD"]) {
      const { amount, proof } = (await api("GET", `/api/sales/${offerId}/payout/${wallets[k].address}`)).body.data;
      const before = await c.musd.balanceOf(wallets[k].address);
      await (await c.sale.connect(wallets[k]).claim(offerId, BigInt(amount), proof)).wait();
      assert.equal((await c.musd.balanceOf(wallets[k].address)) - before, BigInt(amount));
    }
    const viewer = (await api("GET", `/api/sales/${offerId}?address=${wallets.holderB.address}`)).body.viewer;
    assert.equal(viewer.payout.claimed, true);
    await assert.rejects(
      (async () => {
        const { amount, proof } = (await api("GET", `/api/sales/${offerId}/payout/${wallets.holderB.address}`)).body.data;
        await c.sale.connect(wallets.holderB).claim(offerId, BigInt(amount), proof);
      })(),
      /Already claimed/
    );
  });

  it("the platform's own transactions were recorded as Platform gas, and the vote relay as Relayer gas", async () => {
    const summary = await gasAnalyticsService.getGasAnalyticsSummary();
    assert.ok(summary.platformBurden.count >= 3, `expected at least 3 platform transactions, got ${summary.platformBurden.count}`);
    assert.ok(summary.relayerBurden.count >= 1, "the signed-vote batch is Relayer gas");
    assert.ok(summary.operations.SaleVoteRelay?.count >= 1);
    assert.ok(summary.operations.SaleAdmin?.count >= 3);
  });

  it("reading the chain records every business transaction with its stage, method and payer", async () => {
    await gasAnalyticsService.syncChain();
    const summary = await gasAnalyticsService.getGasAnalyticsSummary();
    const stage = Object.fromEntries(summary.stages.map((x) => [x.stage, x]));

    assert.ok(stage.Tokenization.count >= 3, "register, approve and tokenize");
    assert.ok(stage.Listing.count >= 1, "the owner's marketplace approval");
    assert.ok(stage.Purchase.count >= 1, "a signed order was bought from the owner");
    assert.ok(stage.Resale.count >= 2, "two investor-to-investor purchases");
    assert.ok(stage.Escrow.count >= 3, "mUSD approval, createOffer and confirmSale");
    assert.ok(stage.Voting.count >= 3, "openVoting, relayed votes and finalize");
    assert.ok(stage.Payout.count >= 2, "two holders claimed");

    assert.ok(stage.Tokenization.byCategory.AssetOwner > 0, "the owner paid to register");
    assert.ok(stage.Tokenization.byCategory.Platform > 0, "the platform paid to approve and tokenize");
    assert.ok(stage.Listing.byCategory.AssetOwner > 0, "the owner paid for the marketplace approval");
    assert.ok(stage.Voting.byCategory.Relayer > 0, "the relay is Relayer gas");
    assert.ok(stage.Voting.byCategory.Platform > 0, "opening and finalizing the vote is Platform gas");
    assert.ok(stage.Payout.byCategory.Investor > 0, "holders paid their own claims");
    assert.equal(stage.Purchase.byCategory.Investor, stage.Purchase.totalGas, "buyers pay for purchases");
    assert.equal(stage.Resale.byCategory.Investor, stage.Resale.totalGas, "buyers pay for resales");
  });

  it("every recorded transaction has its evidence: hash, contract method, block, gas used and price paid", async () => {
    const relay = (await gasAnalyticsService.listTransactions({ stage: "Voting" })).find((r) => r.method === "castVotesBySig");
    assert.ok(relay, "the relay transaction is listed");
    assert.match(relay.txHash, /^0x[0-9a-f]{64}$/);
    assert.equal(relay.contract, "PropertySale");
    assert.equal(relay.payerCategory, "Relayer");
    assert.ok(relay.blockNumber > 0 && relay.gasUsed > 0 && relay.effectiveGasPriceGwei > 0);

    // The record matches the receipt on the chain.
    const receipt = await provider.getTransactionReceipt(relay.txHash);
    assert.equal(Number(receipt.gasUsed), relay.gasUsed);
    assert.equal(receipt.blockNumber, relay.blockNumber);
  });
});
