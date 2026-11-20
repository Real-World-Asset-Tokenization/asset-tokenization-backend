import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import GasMetric from "../models/GasMetric.js";
import { ethers } from "ethers";
import { buildContext, classify, STAGES, PAYER_CATEGORIES } from "./GasTxClassifier.js";
import { loadDeployment } from "./chainContracts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Written by the measuring scripts in the blockchain project (see each script's header).
const BENCHMARK_FILE = path.join(__dirname, "../contracts/gasBenchmark.json");
const OPTIMIZATION_FILE = path.join(__dirname, "../contracts/gasOptimizations.json");
const SCENARIO_FILE = path.join(__dirname, "../contracts/gasScenario.json");

// The frontend sends "Owner" for asset owners; anything unknown counts as an investor.
const normalizeCategory = (category) => {
  if (category === "Owner") return "AssetOwner";
  return PAYER_CATEGORIES.includes(category) ? category : "Investor";
};

const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null);
const percent = (n) => Math.round(n * 100) / 100;
// Positive = the first approach used less gas than the baseline.
const savingsPercent = (baseline, value) => (baseline > 0 ? percent(((baseline - value) / baseline) * 100) : 0);

// Binary search for the first block where a contract exists (its deployment block).
async function firstBlockWithCode(provider, address, head) {
  if ((await provider.getCode(address, head)) === "0x") return head + 1;
  let low = 0;
  let high = head;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((await provider.getCode(address, mid)) === "0x") low = mid + 1;
    else high = mid;
  }
  return low;
}

// The next block to read, per deployment, so a refresh does not re-scan the whole chain.
const syncCursor = new Map();

class GasAnalyticsService {
  /**
   * Decodes a mined transaction and records it: contract method, stage, and who paid
   * (Platform, AssetOwner, Investor or Relayer). Everything is read from the chain, not from the caller.
   * Returns null for transactions that are not part of the business flow.
   */
  async indexTransaction(txHash) {
    const ctx = await buildContext();
    try {
      const [tx, receipt] = await Promise.all([ctx.provider.getTransaction(txHash), ctx.provider.getTransactionReceipt(txHash)]);
      if (!tx || !receipt) return null;
      const record = await classify(tx, receipt, ctx);
      return record ? await this.recordTransactionGas(record) : null;
    } finally {
      ctx.provider.destroy?.();
    }
  }

  /**
   * Records a transaction the platform wallet sent. Never throws: gas tracking must not break the
   * operation that was already mined. The hints are only used when the chain cannot be decoded.
   */
  async recordPlatformReceipt(receipt, operationType, { assetId = null, roundId = null } = {}) {
    try {
      const indexed = await this.indexTransaction(receipt.hash);
      if (indexed) return indexed;
      return await this.recordTransactionGas({
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        operationType,
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.gasPrice ?? receipt.effectiveGasPrice,
        payerAddress: receipt.from,
        payerCategory: "Platform",
        assetId,
        roundId
      });
    } catch (err) {
      console.warn(`[GasAnalytics] Could not record ${operationType} gas:`, err.message);
      return null;
    }
  }

  /**
   * Reads every block since the last sync and records the business transactions sent to the
   * deployed contracts, so the dashboard shows what really happened on the chain whichever app
   * (or wallet) sent it.
   */
  async syncChain() {
    const ctx = await buildContext();
    try {
      const head = await ctx.provider.getBlockNumber();
      let from = syncCursor.get(ctx.deployment);
      // First look since the server started: begin at the block the contracts were deployed in. Transactions
      // that were already recorded are skipped, so nothing is counted twice.
      if (from === undefined) from = await firstBlockWithCode(ctx.provider, ctx.data.contracts.AssetRegistry.address, head);
      let recorded = 0;
      for (let n = from; n <= head; n++) {
        const block = await ctx.provider.getBlock(n, true);
        for (const tx of block?.prefetchedTransactions || []) {
          if (!ctx.contracts.has(String(tx.to || "").toLowerCase())) continue;
          const receipt = await ctx.provider.getTransactionReceipt(tx.hash);
          const record = receipt && (await classify(tx, receipt, ctx));
          if (record && (await this.recordTransactionGas(record))) recorded++;
        }
      }
      syncCursor.set(ctx.deployment, head + 1);
      return { fromBlock: from, toBlock: head, recorded };
    } finally {
      ctx.provider.destroy?.();
    }
  }

  /**
   * Records transaction gas consumption from a mined transaction receipt.
   */
  async recordTransactionGas({
    txHash,
    blockNumber,
    operationType,
    gasUsed,
    effectiveGasPrice,
    payerAddress,
    payerCategory = "Investor",
    assetId = null,
    roundId = null,
    stage = "Other",
    contractName,
    contractMethod,
    deployment
  }) {
    const gasUsedBig = BigInt(gasUsed);
    const gasPriceBig = BigInt(effectiveGasPrice || 1000000000n); // default 1 Gwei
    const totalFeeWeiBig = gasUsedBig * gasPriceBig;
    const totalFeeEth = Number(ethers.formatEther(totalFeeWeiBig));
    const effectiveGasPriceGwei = Number(ethers.formatUnits(gasPriceBig, "gwei"));

    return GasMetric.create({
      txHash,
      blockNumber,
      operationType,
      gasUsed: Number(gasUsedBig),
      effectiveGasPriceGwei,
      totalFeeWei: totalFeeWeiBig.toString(),
      totalFeeEth,
      payerAddress: payerAddress.toLowerCase(),
      payerCategory: normalizeCategory(payerCategory),
      stage: STAGES.includes(stage) ? stage : "Other",
      contractName,
      contractMethod,
      deployment,
      assetId: assetId != null ? Number(assetId) : null,
      roundId: roundId ? Number(roundId) : null
    });
  }

  /** Records of the deployment the app currently points at (older chains are not mixed in). */
  async currentRecords() {
    let deployment;
    try {
      deployment = loadDeployment().deployment;
    } catch {
      deployment = undefined;
    }
    return deployment ? GasMetric.find({ deployment }) : GasMetric.find();
  }

  /**
   * Summary statistics: totals per payer category, per business stage and per contract method.
   */
  async getGasAnalyticsSummary() {
    const allMetrics = await this.currentRecords();

    const byCategory = {};
    for (const c of PAYER_CATEGORIES) byCategory[c] = { totalGas: 0, totalFeeEth: 0, count: 0 };

    const stageMap = {};
    for (const s of STAGES) {
      stageMap[s] = { stage: s, count: 0, totalGas: 0, avgGas: 0, totalFeeEth: 0, byCategory: Object.fromEntries(PAYER_CATEGORIES.map((c) => [c, 0])) };
    }
    const operationBreakdown = {};
    const methodMap = {};

    for (const m of allMetrics) {
      const category = normalizeCategory(m.payerCategory);
      const bucket = byCategory[category];
      bucket.totalGas += m.gasUsed;
      bucket.totalFeeEth += m.totalFeeEth;
      bucket.count++;

      const stage = stageMap[STAGES.includes(m.stage) ? m.stage : "Other"];
      stage.count++;
      stage.totalGas += m.gasUsed;
      stage.totalFeeEth += m.totalFeeEth;
      stage.byCategory[category] += m.gasUsed;

      if (!operationBreakdown[m.operationType]) {
        operationBreakdown[m.operationType] = { count: 0, totalGas: 0, avgGas: 0, totalFeeEth: 0 };
      }
      operationBreakdown[m.operationType].count++;
      operationBreakdown[m.operationType].totalGas += m.gasUsed;
      operationBreakdown[m.operationType].totalFeeEth += m.totalFeeEth;

      const methodKey = `${m.contractName || "Unknown"}.${m.contractMethod || m.operationType}`;
      if (!methodMap[methodKey]) {
        methodMap[methodKey] = { contract: m.contractName || "Unknown", method: m.contractMethod || m.operationType, stage: m.stage || "Other", count: 0, totalGas: 0, avgGas: 0, totalFeeEth: 0 };
      }
      methodMap[methodKey].count++;
      methodMap[methodKey].totalGas += m.gasUsed;
      methodMap[methodKey].totalFeeEth += m.totalFeeEth;
    }

    for (const item of [...Object.values(operationBreakdown), ...Object.values(stageMap), ...Object.values(methodMap)]) {
      item.avgGas = item.count ? Math.round(item.totalGas / item.count) : 0;
    }

    const totalGasConsumed = PAYER_CATEGORIES.reduce((s, c) => s + byCategory[c].totalGas, 0);
    const totalFeeEth = PAYER_CATEGORIES.reduce((s, c) => s + byCategory[c].totalFeeEth, 0);

    const burden = (category) => ({
      ...byCategory[category],
      percentage: totalGasConsumed > 0
        ? ((byCategory[category].totalGas / totalGasConsumed) * 100).toFixed(1) + "%"
        : "0%"
    });

    return {
      totalTransactions: allMetrics.length,
      totalGasConsumed,
      totalFeeEth,
      platformBurden: burden("Platform"),
      assetOwnerBurden: burden("AssetOwner"),
      investorBurden: burden("Investor"),
      relayerBurden: burden("Relayer"),
      stages: STAGES.map((s) => stageMap[s]),
      methods: Object.values(methodMap).sort((a, b) => b.totalGas - a.totalGas),
      operations: operationBreakdown
    };
  }

  /**
   * The recorded transactions with the evidence behind every number: hash, contract method, block,
   * gas used and the price that was actually paid.
   */
  async listTransactions({ limit = 200, stage, category } = {}) {
    let rows = await this.currentRecords();
    if (stage) rows = rows.filter((r) => r.stage === stage);
    if (category) rows = rows.filter((r) => normalizeCategory(r.payerCategory) === category);
    rows = [...rows].sort((a, b) => b.blockNumber - a.blockNumber || String(b.txHash).localeCompare(String(a.txHash)));
    return rows.slice(0, Math.min(Number(limit) || 200, 1000)).map((r) => ({
      txHash: r.txHash,
      blockNumber: r.blockNumber,
      stage: r.stage || "Other",
      contract: r.contractName || null,
      method: r.contractMethod || r.operationType,
      payerAddress: r.payerAddress,
      payerCategory: normalizeCategory(r.payerCategory),
      gasUsed: r.gasUsed,
      effectiveGasPriceGwei: r.effectiveGasPriceGwei,
      totalFeeEth: r.totalFeeEth,
      assetId: r.assetId ?? null
    }));
  }

  /**
   * The Merkle vs push vs snapshot benchmark measured on a Hardhat node by scripts/measureGasBenchmark.js.
   * Nothing is estimated here; the comparison percentages are derived from the measured gas.
   * Both views are given because they differ: the platform pays far less with Merkle, but the network as a whole
   * uses more gas, because the claims are paid by investors on top of the setup.
   */
  getResearchBenchmark() {
    const file = readJson(BENCHMARK_FILE);
    if (!file) return { measured: false, generatedAt: null, data: [] };

    const data = file.scenarios.map((s) => {
      const merkle = s.proposedFramework;
      const push = s.baselinePushFramework;
      const snapshot = s.baselineSnapshotFramework;
      return {
        ...s,
        comparison: {
          // Gas the platform itself pays
          platformGasSavingsVsPushPercent: savingsPercent(push.totalNetworkGas, merkle.platformSetupGas),
          platformGasSavingsVsSnapshotPercent: savingsPercent(snapshot.platformSetupGas, merkle.platformSetupGas),
          // Gas the whole network spends (platform + investors). Positive overhead = Merkle uses MORE gas.
          networkGasOverheadVsPushPercent: -savingsPercent(push.totalNetworkGas, merkle.totalNetworkGas),
          networkGasOverheadVsSnapshotPercent: -savingsPercent(snapshot.totalNetworkGas, merkle.totalNetworkGas),
          // Who ends up paying under Merkle
          investorGasUnderMerkle: merkle.totalInvestorGas,
          investorShareUnderMerklePercent: percent((merkle.totalInvestorGas / merkle.totalNetworkGas) * 100)
        }
      };
    });
    return { measured: true, generatedAt: file.generatedAt, blockGasLimit: file.blockGasLimit, data };
  }

  /**
   * Measured gas saved by signed marketplace orders, permit approvals, batched signed votes and single minting.
   * Empty until scripts/measureOptimizationGas.js has been run.
   */
  getOptimizationBenchmark() {
    const file = readJson(OPTIMIZATION_FILE);
    if (!file) return { measured: false, generatedAt: null, listing: null, voting: [], minting: [] };
    return { measured: true, generatedAt: file.generatedAt, listing: file.listing, voting: file.voting, minting: file.minting || [] };
  }

  /**
   * The end-to-end property scenario (tokenize, list, buy, resell, vote, escrow, pay out) measured with the
   * baseline approach and the optimized approach, step by step with transaction evidence.
   * Empty until scripts/measureScenarioGas.js has been run.
   */
  getScenarioBenchmark() {
    const file = readJson(SCENARIO_FILE);
    if (!file) return { measured: false, generatedAt: null, network: null, cohorts: [] };
    const stageGas = (flow, stage) => flow.byStage.find((x) => x.stage === stage)?.totalGas || 0;
    const cohorts = file.cohorts.map((c) => {
      const b = c.flows.baseline;
      const o = c.flows.optimized;
      const withoutMinting = (f) => f.totalGas - stageGas(f, "Tokenization");
      const { platformGasSavedPercent, ...comparison } = c.comparison;
      return {
        ...c,
        comparison: {
          ...comparison,
          // The platform wallet alone, and the platform wallet together with the relay it sends (the relay is Relayer gas).
          platformOnlySavedPercent: savingsPercent(b.byCategory.Platform, o.byCategory.Platform),
          platformWithRelayerSavedPercent: savingsPercent(b.byCategory.Platform, o.byCategory.Platform + o.byCategory.Relayer),
          // Tokenization is the same for any number of investors, so show the saving without it too.
          totalExcludingTokenizationSavedPercent: savingsPercent(withoutMinting(b), withoutMinting(o)),
          networkGasBaseline: b.totalGas,
          networkGasOptimized: o.totalGas,
          byPayer: ["Platform", "AssetOwner", "Investor", "Relayer"].map((category) => ({
            category,
            baselineGas: b.byCategory[category],
            optimizedGas: o.byCategory[category],
            savedPercent: savingsPercent(b.byCategory[category], o.byCategory[category])
          }))
        }
      };
    });
    return { measured: true, generatedAt: file.generatedAt, network: file.network, cohorts };
  }
}

const gasServiceInstance = new GasAnalyticsService();
export default gasServiceInstance;
