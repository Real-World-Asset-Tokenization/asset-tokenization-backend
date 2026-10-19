import { ethers } from "ethers";
import InvestorAllocation from "../models/InvestorAllocation.js";
import DistributionRound from "../models/DistributionRound.js";

/**
 * Commutative pair hash matching OpenZeppelin's Hashes.commutativeKeccak256
 */
export function hashPair(a, b) {
  const bufA = Buffer.from(a.slice(2), "hex");
  const bufB = Buffer.from(b.slice(2), "hex");
  return bufA.compare(bufB) < 0
    ? ethers.keccak256(ethers.concat([a, b]))
    : ethers.keccak256(ethers.concat([b, a]));
}

/**
 * Computes double-hashed leaf matching ProfitDistribution.getLeafHash
 */
export function hashLeaf(chainId, contractAddress, assetId, roundId, claimant, amountBaseUnits) {
  const inner = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "address", "uint256", "uint256", "address", "uint256"],
      [
        BigInt(chainId),
        contractAddress,
        BigInt(assetId),
        BigInt(roundId),
        claimant,
        BigInt(amountBaseUnits)
      ]
    )
  );
  return ethers.keccak256(inner);
}

export class MerkleTreeEngine {
  constructor(leaves) {
    if (!leaves || leaves.length === 0) {
      throw new Error("Cannot build Merkle tree with 0 leaves");
    }
    this.leaves = [...leaves];
    this.layers = [this.leaves];
    this._buildTree();
  }

  _buildTree() {
    let current = this.layers[0];
    while (current.length > 1) {
      const nextLevel = [];
      for (let i = 0; i < current.length; i += 2) {
        if (i + 1 < current.length) {
          nextLevel.push(hashPair(current[i], current[i + 1]));
        } else {
          // Promote odd node to next level
          nextLevel.push(current[i]);
        }
      }
      this.layers.push(nextLevel);
      current = nextLevel;
    }
  }

  getRoot() {
    return this.layers[this.layers.length - 1][0];
  }

  getProof(leafIndex) {
    if (leafIndex < 0 || leafIndex >= this.leaves.length) {
      throw new Error(`Invalid leaf index: ${leafIndex}`);
    }

    const proof = [];
    let index = leafIndex;

    for (let i = 0; i < this.layers.length - 1; i++) {
      const layer = this.layers[i];
      const isRightNode = index % 2 === 1;
      const pairIndex = isRightNode ? index - 1 : index + 1;

      if (pairIndex < layer.length) {
        proof.push(layer[pairIndex]);
      }

      index = Math.floor(index / 2);
    }

    return proof;
  }

  verifyProof(proof, root, leaf) {
    let computedHash = leaf;
    for (const sibling of proof) {
      computedHash = hashPair(computedHash, sibling);
    }
    return computedHash.toLowerCase() === root.toLowerCase();
  }
}

class MerkleDistributionService {
  /**
   * Generates Merkle root and proofs from finalized allocations and records them in DB.
   */
  async buildAndPersistDistribution({
    roundId,
    assetId,
    chainId,
    distributionContractAddress,
    paymentTokenAddress,
    periodLabel,
    reportHash,
    allocations,
    totalPayoutBaseUnits,
    totalPayoutFormatted,
    totalEligibleTokenSeconds
  }) {
    if (!allocations || allocations.length === 0) {
      throw new Error("Cannot generate Merkle tree: zero allocations provided");
    }

    // Filter out zero-payout allocations
    const eligibleAllocations = allocations.filter(
      (a) => BigInt(a.timeWeightedPayoutBaseUnits) > 0n
    );

    if (eligibleAllocations.length === 0) {
      throw new Error("No participants with positive dividend entitlement");
    }

    // Sort deterministically by wallet address
    eligibleAllocations.sort((a, b) => a.walletAddress.localeCompare(b.walletAddress));

    // Generate cryptographic leaves
    const leaves = eligibleAllocations.map((alloc) =>
      hashLeaf(
        chainId,
        distributionContractAddress,
        assetId,
        roundId,
        alloc.walletAddress,
        alloc.timeWeightedPayoutBaseUnits
      )
    );

    // Build Merkle Tree
    const tree = new MerkleTreeEngine(leaves);
    const merkleRoot = tree.getRoot();

    console.log(`[MerkleDistributionService] Built tree for Round #${roundId}. Leaves: ${leaves.length}, Root: ${merkleRoot}`);

    // Generate and independently verify proofs for each investor
    const persistedAllocations = [];
    for (let i = 0; i < eligibleAllocations.length; i++) {
      const alloc = eligibleAllocations[i];
      const leaf = leaves[i];
      const proof = tree.getProof(i);

      // Sanity verify
      const isValid = tree.verifyProof(proof, merkleRoot, leaf);
      if (!isValid) {
        throw new Error(`Critical: generated proof for ${alloc.walletAddress} failed internal verification!`);
      }

      persistedAllocations.push({
        roundId: Number(roundId),
        assetId: Number(assetId),
        walletAddress: alloc.walletAddress.toLowerCase(),
        openingBalance: alloc.openingBalance,
        closingBalance: alloc.closingBalance,
        tokenSeconds: alloc.tokenSeconds,
        weightFraction: alloc.weightFraction,
        payoutUnits: alloc.timeWeightedPayoutBaseUnits,
        payoutAmountFormatted: alloc.timeWeightedPayoutFormatted,
        merkleProof: proof,
        leafHash: leaf,
        leafIndex: i,
        isClaimed: false
      });
    }

    // Persist allocations to DB
    await InvestorAllocation.insertMany(persistedAllocations);

    // Persist or update DistributionRound
    const roundRecord = await DistributionRound.create({
      roundId: Number(roundId),
      assetId: Number(assetId),
      periodLabel,
      merkleRoot,
      totalPayout: Number(totalPayoutBaseUnits),
      totalPayoutFormatted,
      fundedAmount: 0,
      claimedAmount: 0,
      paymentTokenAddress,
      reportHash,
      status: "Approved",
      eligibleHoldersCount: eligibleAllocations.length,
      totalEligibleTokenSeconds
    });

    return {
      roundId,
      merkleRoot,
      eligibleHoldersCount: eligibleAllocations.length,
      roundRecord,
      allocations: persistedAllocations
    };
  }

  /**
   * Retrieves an investor's claim proof and entitlement for a specific round.
   */
  async getInvestorClaimProof(roundId, walletAddress) {
    const allocation = await InvestorAllocation.findOne({
      roundId: Number(roundId),
      walletAddress: walletAddress.toLowerCase()
    });

    if (!allocation) {
      return null;
    }

    const round = await DistributionRound.findOne({ roundId: Number(roundId) });

    return {
      roundId: Number(roundId),
      assetId: allocation.assetId,
      walletAddress: allocation.walletAddress,
      payoutUnits: allocation.payoutUnits,
      payoutAmountFormatted: allocation.payoutAmountFormatted,
      merkleProof: allocation.merkleProof,
      leafHash: allocation.leafHash,
      isClaimed: allocation.isClaimed,
      roundStatus: round?.status || "Unknown",
      merkleRoot: round?.merkleRoot || ""
    };
  }
}

const merkleServiceInstance = new MerkleDistributionService();
export default merkleServiceInstance;
