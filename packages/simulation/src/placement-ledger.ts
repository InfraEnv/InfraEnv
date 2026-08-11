import type {
  PlacementIssue,
  PlacementIssueCode,
  PlacementLedger,
  PlacementLedgerResult,
  PlacementPlan
} from "@infraenv/shared";

export const PLACEMENT_LEDGER_DISCLOSURE =
  "SIMULATED / S2 - complete logical placement only; each allocation belongs to one shard and no HBM-sized host memory is allocated.";

interface LogicalRange {
  id: string;
  start: number;
  end: number;
}

interface TensorShardGroup {
  artifactId: string;
  tensorName: string;
  expectedCount: number;
  indexes: Map<number, string>;
  inconsistent: boolean;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareById<T extends { id: string }>(left: T, right: T): number {
  return compareText(left.id, right.id);
}

function createIssue(
  code: PlacementIssueCode,
  subjectId: string,
  message: string,
  relatedId?: string
): PlacementIssue {
  return relatedId === undefined
    ? { code, subjectId, message }
    : { code, subjectId, relatedId, message };
}

function indexUnique<T extends { id: string }>(
  items: readonly T[],
  entityName: string,
  issues: PlacementIssue[]
): Map<string, T> {
  const index = new Map<string, T>();
  for (const item of [...items].sort(compareById)) {
    if (index.has(item.id)) {
      issues.push(createIssue("duplicate-id", item.id, `Duplicate ${entityName} id ${item.id}.`));
      continue;
    }
    index.set(item.id, item);
  }
  return index;
}

function logicalEnd(offsetBytes: number, sizeBytes: number): number | undefined {
  if (!Number.isSafeInteger(offsetBytes) || offsetBytes < 0) return undefined;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) return undefined;
  const end = offsetBytes + sizeBytes;
  return Number.isSafeInteger(end) ? end : undefined;
}

function isPositiveSafeByteCount(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function addRange(
  rangesByOwner: Map<string, LogicalRange[]>,
  ownerId: string,
  id: string,
  start: number,
  end: number
): void {
  const ranges = rangesByOwner.get(ownerId) ?? [];
  ranges.push({ id, start, end });
  rangesByOwner.set(ownerId, ranges);
}

function detectOverlaps(
  rangesByOwner: ReadonlyMap<string, readonly LogicalRange[]>,
  code: "allocation-overlap" | "shard-overlap",
  issues: PlacementIssue[]
): void {
  for (const ownerId of [...rangesByOwner.keys()].sort(compareText)) {
    const ranges = [...(rangesByOwner.get(ownerId) ?? [])].sort(
      (left, right) => left.start - right.start || left.end - right.end || compareText(left.id, right.id)
    );
    let active: LogicalRange | undefined;
    for (const range of ranges) {
      if (active !== undefined && range.start < active.end) {
        issues.push(
          createIssue(code, range.id, `${range.id} overlaps ${active.id} within ${ownerId}.`, active.id)
        );
      }
      if (active === undefined || range.end > active.end) active = range;
    }
  }
}

function sortIssues(issues: PlacementIssue[]): PlacementIssue[] {
  return issues.sort(
    (left, right) =>
      compareText(left.code, right.code) ||
      compareText(left.subjectId, right.subjectId) ||
      compareText(left.relatedId ?? "", right.relatedId ?? "") ||
      compareText(left.message, right.message)
  );
}

function safeAggregate(values: readonly number[]): number | undefined {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) return undefined;
  }
  return total;
}

/**
 * Validates and summarizes a sparse logical placement plan.
 *
 * The function only creates metadata proportional to the number of plan objects.
 * Byte capacities remain scalar numbers and never become ArrayBuffers or Buffers.
 */
export function buildPlacementLedger(plan: PlacementPlan): PlacementLedgerResult {
  const issues: PlacementIssue[] = [];
  const pools = indexUnique(plan.memoryPools, "memory pool", issues);
  const artifacts = indexUnique(plan.artifacts, "model artifact", issues);
  const allocations = indexUnique(plan.allocations, "allocation", issues);
  const shards = indexUnique(plan.shards, "tensor shard", issues);

  for (const pool of [...pools.values()].sort(compareById)) {
    if (!isPositiveSafeByteCount(pool.capacityBytes)) {
      issues.push(
        createIssue(
          "invalid-byte-range",
          pool.id,
          `${pool.id} capacityBytes must be a positive safe integer.`
        )
      );
    }
  }

  for (const artifact of [...artifacts.values()].sort(compareById)) {
    if (!isPositiveSafeByteCount(artifact.sizeBytes)) {
      issues.push(
        createIssue(
          "invalid-byte-range",
          artifact.id,
          `${artifact.id} sizeBytes must be a positive safe integer.`
        )
      );
    }
  }

  const allocationRanges = new Map<string, LogicalRange[]>();
  for (const allocation of [...allocations.values()].sort(compareById)) {
    const pool = pools.get(allocation.poolId);
    if (pool === undefined) {
      issues.push(
        createIssue(
          "missing-pool",
          allocation.id,
          `${allocation.id} references missing pool ${allocation.poolId}.`,
          allocation.poolId
        )
      );
    }

    const end = logicalEnd(allocation.offsetBytes, allocation.sizeBytes);
    if (end === undefined) {
      issues.push(
        createIssue(
          "invalid-byte-range",
          allocation.id,
          `${allocation.id} must use a non-negative safe offset and positive safe size.`
        )
      );
      continue;
    }

    if (pool !== undefined) {
      addRange(allocationRanges, pool.id, allocation.id, allocation.offsetBytes, end);
      if (isPositiveSafeByteCount(pool.capacityBytes) && end > pool.capacityBytes) {
        issues.push(
          createIssue(
            "allocation-out-of-bounds",
            allocation.id,
            `${allocation.id} ends at byte ${end}, beyond ${pool.id} capacity ${pool.capacityBytes}.`,
            pool.id
          )
        );
      }
    }
  }
  detectOverlaps(allocationRanges, "allocation-overlap", issues);

  const shardRanges = new Map<string, LogicalRange[]>();
  const allocationOwners = new Map<string, string>();
  const tensorShardGroups = new Map<string, TensorShardGroup>();
  for (const shard of [...shards.values()].sort(compareById)) {
    const artifact = artifacts.get(shard.artifactId);
    if (artifact === undefined) {
      issues.push(
        createIssue(
          "missing-artifact",
          shard.id,
          `${shard.id} references missing artifact ${shard.artifactId}.`,
          shard.artifactId
        )
      );
    }

    const allocation = allocations.get(shard.allocationId);
    if (allocation === undefined) {
      issues.push(
        createIssue(
          "missing-allocation",
          shard.id,
          `${shard.id} references missing allocation ${shard.allocationId}.`,
          shard.allocationId
        )
      );
    } else {
      const previousOwner = allocationOwners.get(allocation.id);
      if (previousOwner !== undefined) {
        issues.push(
          createIssue(
            "allocation-reused",
            shard.id,
            `${allocation.id} is already assigned to ${previousOwner}.`,
            previousOwner
          )
        );
      } else {
        allocationOwners.set(allocation.id, shard.id);
      }
      if (
        isPositiveSafeByteCount(shard.sizeBytes) &&
        isPositiveSafeByteCount(allocation.sizeBytes) &&
        shard.sizeBytes > allocation.sizeBytes
      ) {
        issues.push(
          createIssue(
            "allocation-too-small",
            shard.id,
            `${shard.id} needs ${shard.sizeBytes} bytes but ${allocation.id} provides ${allocation.sizeBytes}.`,
            allocation.id
          )
        );
      }
    }

    const end = logicalEnd(shard.artifactOffsetBytes, shard.sizeBytes);
    if (end === undefined) {
      issues.push(
        createIssue(
          "invalid-byte-range",
          shard.id,
          `${shard.id} must use a non-negative safe artifact offset and positive safe size.`
        )
      );
    } else if (artifact !== undefined) {
      addRange(shardRanges, artifact.id, shard.id, shard.artifactOffsetBytes, end);
      if (isPositiveSafeByteCount(artifact.sizeBytes) && end > artifact.sizeBytes) {
        issues.push(
          createIssue(
            "shard-out-of-bounds",
            shard.id,
            `${shard.id} ends at byte ${end}, beyond ${artifact.id} size ${artifact.sizeBytes}.`,
            artifact.id
          )
        );
      }
    }

    if (
      !Number.isSafeInteger(shard.shardIndex) ||
      !Number.isSafeInteger(shard.shardCount) ||
      shard.shardIndex < 0 ||
      shard.shardCount <= 0 ||
      shard.shardIndex >= shard.shardCount
    ) {
      issues.push(
        createIssue(
          "invalid-shard-index",
          shard.id,
          `${shard.id} must satisfy 0 <= shardIndex < shardCount using safe integers.`
        )
      );
    } else {
      const tensorKey = `${shard.artifactId}\u0000${shard.tensorName}`;
      const group = tensorShardGroups.get(tensorKey);
      if (group === undefined) {
        tensorShardGroups.set(tensorKey, {
          artifactId: shard.artifactId,
          tensorName: shard.tensorName,
          expectedCount: shard.shardCount,
          indexes: new Map([[shard.shardIndex, shard.id]]),
          inconsistent: false
        });
      } else if (group.expectedCount !== shard.shardCount) {
        group.inconsistent = true;
        issues.push(
          createIssue(
            "inconsistent-shard-count",
            shard.id,
            `${shard.tensorName} declares shardCount ${shard.shardCount}; expected ${group.expectedCount}.`,
            shard.artifactId
          )
        );
      } else {
        const existingShardId = group.indexes.get(shard.shardIndex);
        if (existingShardId !== undefined) {
          issues.push(
            createIssue(
              "duplicate-shard-index",
              shard.id,
              `${shard.tensorName} shardIndex ${shard.shardIndex} is already used by ${existingShardId}.`,
              existingShardId
            )
          );
        } else {
          group.indexes.set(shard.shardIndex, shard.id);
        }
      }
    }
  }
  detectOverlaps(shardRanges, "shard-overlap", issues);

  for (const tensorKey of [...tensorShardGroups.keys()].sort(compareText)) {
    const group = tensorShardGroups.get(tensorKey);
    if (group === undefined || group.inconsistent || group.indexes.size === group.expectedCount) continue;
    const sortedIndexes = [...group.indexes.keys()].sort((left, right) => left - right);
    let firstMissingIndex = 0;
    for (const index of sortedIndexes) {
      if (index !== firstMissingIndex) break;
      firstMissingIndex += 1;
    }
    issues.push(
      createIssue(
        "missing-shard-index",
        `${group.artifactId}#${group.tensorName}`,
        `${group.tensorName} is missing shardIndex ${firstMissingIndex}; a complete plan requires 0 through ${group.expectedCount - 1}.`,
        group.artifactId
      )
    );
  }

  const capacityTotal = safeAggregate(
    [...pools.values()].filter((pool) => isPositiveSafeByteCount(pool.capacityBytes)).map((pool) => pool.capacityBytes)
  );
  if (capacityTotal === undefined) {
    issues.push(
      createIssue(
        "invalid-byte-range",
        plan.id,
        `${plan.id} total logical capacity exceeds Number.MAX_SAFE_INTEGER.`
      )
    );
  }

  if (issues.length > 0) {
    return {
      ok: false,
      simulationLevel: "S2",
      disclosure: PLACEMENT_LEDGER_DISCLOSURE,
      issues: sortIssues(issues)
    };
  }

  const sortedPools = [...pools.values()].sort(compareById);
  const sortedAllocations = [...allocations.values()].sort(compareById);
  const sortedShards = [...shards.values()].sort(compareById);
  const poolUsage = sortedPools.map((pool) => {
    const poolAllocations = sortedAllocations.filter((allocation) => allocation.poolId === pool.id);
    const allocationIds = new Set(poolAllocations.map((allocation) => allocation.id));
    const allocatedBytes = poolAllocations.reduce((total, allocation) => total + allocation.sizeBytes, 0);
    const placedShardBytes = sortedShards
      .filter((shard) => allocationIds.has(shard.allocationId))
      .reduce((total, shard) => total + shard.sizeBytes, 0);
    return {
      poolId: pool.id,
      capacityBytes: pool.capacityBytes,
      allocatedBytes,
      placedShardBytes,
      freeBytes: pool.capacityBytes - allocatedBytes,
      utilizationRatio: allocatedBytes / pool.capacityBytes
    };
  });

  const ledger: PlacementLedger = {
    planId: plan.id,
    totalCapacityBytes: capacityTotal ?? 0,
    totalAllocatedBytes: poolUsage.reduce((total, usage) => total + usage.allocatedBytes, 0),
    totalPlacedShardBytes: poolUsage.reduce((total, usage) => total + usage.placedShardBytes, 0),
    pools: poolUsage
  };

  return {
    ok: true,
    simulationLevel: "S2",
    disclosure: PLACEMENT_LEDGER_DISCLOSURE,
    ledger,
    issues: []
  };
}
