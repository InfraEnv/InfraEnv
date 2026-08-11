import { describe, expect, it } from "vitest";
import type { PlacementPlan } from "@infraenv/shared";
import { buildPlacementLedger } from "@infraenv/simulation";

const PIB = 2 ** 50;

function validPlan(): PlacementPlan {
  return {
    id: "placement-plan:two-way-tensor-parallel",
    name: "Two-way tensor parallel placement",
    memoryPools: [
      {
        id: "memory-pool:gpu-1-hbm",
        ownerId: "gpu:1",
        kind: "hbm",
        capacityBytes: 2 * PIB
      },
      {
        id: "memory-pool:gpu-0-hbm",
        ownerId: "gpu:0",
        kind: "hbm",
        capacityBytes: 2 * PIB
      }
    ],
    artifacts: [
      {
        id: "model-artifact:large-model",
        name: "Large logical model",
        format: "safetensors",
        sizeBytes: 2 * PIB
      }
    ],
    allocations: [
      {
        id: "allocation:gpu-1-shard",
        poolId: "memory-pool:gpu-1-hbm",
        offsetBytes: 0,
        sizeBytes: PIB
      },
      {
        id: "allocation:gpu-0-shard",
        poolId: "memory-pool:gpu-0-hbm",
        offsetBytes: 0,
        sizeBytes: PIB
      }
    ],
    shards: [
      {
        id: "tensor-shard:model-1-of-2",
        artifactId: "model-artifact:large-model",
        allocationId: "allocation:gpu-1-shard",
        tensorName: "model.weights",
        shardIndex: 1,
        shardCount: 2,
        artifactOffsetBytes: PIB,
        sizeBytes: PIB
      },
      {
        id: "tensor-shard:model-0-of-2",
        artifactId: "model-artifact:large-model",
        allocationId: "allocation:gpu-0-shard",
        tensorName: "model.weights",
        shardIndex: 0,
        shardCount: 2,
        artifactOffsetBytes: 0,
        sizeBytes: PIB
      }
    ]
  };
}

describe("sparse logical placement ledger", () => {
  it("accounts for multi-petabyte logical capacity without materializing host memory", () => {
    const result = buildPlacementLedger(validPlan());
    expect(result.ok).toBe(true);
    expect(result.simulationLevel).toBe("S2");
    expect(result.disclosure).toContain("SIMULATED / S2");
    expect(result.disclosure).toContain("each allocation belongs to one shard");
    expect(result.disclosure).toContain("no HBM-sized host memory");
    if (!result.ok) throw new Error("expected a valid placement ledger");
    expect(result.ledger).toEqual({
      planId: "placement-plan:two-way-tensor-parallel",
      totalCapacityBytes: 4 * PIB,
      totalAllocatedBytes: 2 * PIB,
      totalPlacedShardBytes: 2 * PIB,
      pools: [
        {
          poolId: "memory-pool:gpu-0-hbm",
          capacityBytes: 2 * PIB,
          allocatedBytes: PIB,
          placedShardBytes: PIB,
          freeBytes: PIB,
          utilizationRatio: 0.5
        },
        {
          poolId: "memory-pool:gpu-1-hbm",
          capacityBytes: 2 * PIB,
          allocatedBytes: PIB,
          placedShardBytes: PIB,
          freeBytes: PIB,
          utilizationRatio: 0.5
        }
      ]
    });
    expect(JSON.stringify(result).length).toBeLessThan(2_000);
  });

  it("is deterministic even when entity arrays arrive in a different order", () => {
    const first = validPlan();
    const second: PlacementPlan = {
      ...first,
      memoryPools: [...first.memoryPools].reverse(),
      artifacts: [...first.artifacts].reverse(),
      allocations: [...first.allocations].reverse(),
      shards: [...first.shards].reverse()
    };
    expect(buildPlacementLedger(second)).toEqual(buildPlacementLedger(first));
  });

  it("rejects missing shard-to-allocation, shard-to-artifact, and allocation-to-pool references", () => {
    const plan: PlacementPlan = {
      id: "placement-plan:missing-references",
      name: "Missing references",
      memoryPools: [],
      artifacts: [],
      allocations: [
        {
          id: "allocation:orphan",
          poolId: "memory-pool:missing",
          offsetBytes: 0,
          sizeBytes: 64
        }
      ],
      shards: [
        {
          id: "tensor-shard:orphan",
          artifactId: "model-artifact:missing",
          allocationId: "allocation:missing",
          tensorName: "missing.weight",
          shardIndex: 0,
          shardCount: 1,
          artifactOffsetBytes: 0,
          sizeBytes: 64
        }
      ]
    };

    const result = buildPlacementLedger(plan);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected reference validation to fail");
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "missing-allocation",
      "missing-artifact",
      "missing-pool"
    ]);
  });

  it("rejects pool overcommit and overlapping logical ranges", () => {
    const plan: PlacementPlan = {
      id: "placement-plan:overlap",
      name: "Overlapping placement",
      memoryPools: [
        { id: "memory-pool:gpu-0-hbm", ownerId: "gpu:0", kind: "hbm", capacityBytes: 100 }
      ],
      artifacts: [
        { id: "model-artifact:model", name: "Model", format: "custom", sizeBytes: 100 }
      ],
      allocations: [
        { id: "allocation:first", poolId: "memory-pool:gpu-0-hbm", offsetBytes: 0, sizeBytes: 70 },
        { id: "allocation:second", poolId: "memory-pool:gpu-0-hbm", offsetBytes: 60, sizeBytes: 50 }
      ],
      shards: [
        {
          id: "tensor-shard:first",
          artifactId: "model-artifact:model",
          allocationId: "allocation:first",
          tensorName: "weights",
          shardIndex: 0,
          shardCount: 2,
          artifactOffsetBytes: 0,
          sizeBytes: 70
        },
        {
          id: "tensor-shard:second",
          artifactId: "model-artifact:model",
          allocationId: "allocation:second",
          tensorName: "weights",
          shardIndex: 1,
          shardCount: 2,
          artifactOffsetBytes: 60,
          sizeBytes: 50
        }
      ]
    };

    const result = buildPlacementLedger(plan);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected range validation to fail");
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "allocation-out-of-bounds",
      "allocation-overlap",
      "shard-out-of-bounds",
      "shard-overlap"
    ]);
  });

  it("rejects an undersized allocation reused by multiple shards", () => {
    const plan = validPlan();
    plan.allocations = [
      {
        id: "allocation:shared",
        poolId: "memory-pool:gpu-0-hbm",
        offsetBytes: 0,
        sizeBytes: 32
      }
    ];
    plan.shards = plan.shards.map((shard, index) => ({
      ...shard,
      id: `tensor-shard:reused-${index}`,
      allocationId: "allocation:shared",
      artifactOffsetBytes: index * 64,
      sizeBytes: 64
    }));

    const result = buildPlacementLedger(plan);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected allocation validation to fail");
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "allocation-reused",
      "allocation-too-small",
      "allocation-too-small"
    ]);
  });

  it("rejects duplicate and missing indexes because a PlacementPlan is complete", () => {
    const plan = validPlan();
    plan.shards = plan.shards.map((shard) => ({ ...shard, shardIndex: 0 }));

    const result = buildPlacementLedger(plan);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected complete shard index validation to fail");
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "duplicate-shard-index",
      "missing-shard-index"
    ]);
    expect(result.issues.find((issue) => issue.code === "missing-shard-index")?.message).toContain(
      "missing shardIndex 1"
    );
  });

  it("rejects an index gap even when remaining indexes are unique", () => {
    const plan = validPlan();
    plan.shards = plan.shards.filter((shard) => shard.shardIndex === 0);

    const result = buildPlacementLedger(plan);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected complete shard index validation to fail");
    expect(result.issues).toMatchObject([
      { code: "missing-shard-index", subjectId: "model-artifact:large-model#model.weights" }
    ]);
  });
});
