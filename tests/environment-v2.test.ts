import { describe, expect, it } from "vitest";
import { checkEnvironment } from "@infraenv/protocol";
import type { EnvironmentInstance, EnvironmentSnapshot } from "@infraenv/shared";
import {
  CurriculumResolver,
  NodeContextSimulator,
  environmentFromScenario,
  findSlowWorkerLab,
  findSlowWorkerRuntimeScenario,
  findSlowWorkerScenarioDocument,
  modelBoot,
  modelPerformance,
  parseHardwareGraph,
  runtimeCurriculumProfile
} from "@infraenv/simulation";

function fixture(): { snapshot: EnvironmentSnapshot; instance: EnvironmentInstance } {
  const document = environmentFromScenario(findSlowWorkerRuntimeScenario, "2026-08-11T00:00:00.000Z");
  document.spec.placement = { rackCount: 4, nodesPerRack: 4 };
  const graph = parseHardwareGraph(document);
  const boot = modelBoot(document, graph);
  const performance = modelPerformance(document, graph);
  const snapshot: EnvironmentSnapshot = {
    apiVersion: "infraenv.io/v1alpha1",
    kind: "EnvironmentSnapshot",
    metadata: { id: "snapshot:find-slow-worker-r1", environmentId: document.metadata.id, revision: 1, createdAt: document.metadata.createdAt },
    checksum: `sha256-${"0".repeat(64)}`,
    document,
    graph,
    boot,
    performance
  };
  const instance: EnvironmentInstance = {
    apiVersion: "infraenv.io/v1alpha1",
    kind: "EnvironmentInstance",
    metadata: { id: "instance:test", environmentId: document.metadata.id, snapshotId: snapshot.metadata.id, createdAt: document.metadata.createdAt, updatedAt: document.metadata.updatedAt },
    state: "ready",
    activeNodeId: "node00",
    boot
  };
  return { snapshot, instance };
}

describe("v0.2 curriculum resolver and Environment model", () => {
  it("resolves exact Scenario -> Preset -> System/Fabric/Boot/Accelerator references", () => {
    const resolver = new CurriculumResolver(runtimeCurriculumProfile);
    expect(findSlowWorkerLab.scenarioRef).toEqual({ id: "scenario:slow-worker-bandwidth-drop", version: "2.0.0" });
    expect(findSlowWorkerScenarioDocument.presetRef).toEqual({ id: "preset:h100-fat-tree-16x8", version: "1.0.0" });
    expect(resolver.require({ id: "preset:h100-fat-tree-16x8", version: "1.0.0" }).source).toBe("curriculum");
    expect(findSlowWorkerRuntimeScenario.version).toBe("2.0.0");
    expect(findSlowWorkerRuntimeScenario.cluster).toMatchObject({ nodeCount: 16, gpusPerNode: 8, totalGpuCount: 128, gpuModel: "H100 SXM 80GB" });
    expect(findSlowWorkerRuntimeScenario.cluster.systemRef).toEqual({ id: "system:dgx-h100", version: "1.0.0" });
    expect(findSlowWorkerRuntimeScenario.cluster.fabricRef).toEqual({ id: "fabric:infiniband-ndr400", version: "1.0.0" });
    expect(findSlowWorkerRuntimeScenario.cluster.bootProfileRef).toEqual({ id: "boot:gpu-node-standard", version: "1.0.0" });
  });

  it("builds a deterministic S2 hardware graph without inventing optional storage", () => {
    const first = fixture().snapshot;
    const second = fixture().snapshot;
    expect(checkEnvironment(first.document).valid).toBe(true);
    expect(first.document.metadata.id).toBe("environment:find-slow-worker");
    expect(first.document.spec.simulationLevel).toBe("S2");
    expect(first.document.spec.storage).toEqual([]);
    expect(first.graph).toEqual(second.graph);
    expect(first.boot).toEqual(second.boot);
    expect(first.performance).toEqual(second.performance);
    expect(first.graph.totals).toMatchObject({ systems: 16, accelerators: 128 });
    expect(first.graph.nodes.filter((node) => node.kind === "rack")).toHaveLength(4);
    for (const kind of ["cluster", "rack", "chassis", "node", "cpu-numa", "pcie-root", "pcie-switch", "gpu", "memory", "nvswitch", "nic-dpu", "fabric-switch"] as const) {
      expect(first.graph.nodes.some((node) => node.kind === kind), `missing ${kind}`).toBe(true);
    }
    expect(first.graph.edges.every((edge) => edge.direction && edge.health)).toBe(true);
    expect(first.performance).toMatchObject({ seed: 240803, confidence: "behavioral-s2" });
    expect(first.performance.disclosure).toContain("SIMULATED / S2");
  });

  it("accepts exactly 4096 logical GPUs and rejects 4097 or more", () => {
    const atLimit = environmentFromScenario(findSlowWorkerRuntimeScenario, "2026-08-11T00:00:00.000Z");
    atLimit.spec.nodes = [{ ...atLimit.spec.nodes[0]!, count: 512 }];
    atLimit.spec.fabrics = atLimit.spec.fabrics.map((fabric) => ({ ...fabric, endpointNodeIds: [atLimit.spec.nodes[0]!.id] }));
    expect(parseHardwareGraph(atLimit).totals.accelerators).toBe(4096);

    const aboveLimit = structuredClone(atLimit);
    aboveLimit.spec.nodes.push({
      ...structuredClone(atLimit.spec.nodes[0]!),
      id: "one-extra-node",
      count: 1,
      accelerators: [{ ...structuredClone(atLimit.spec.nodes[0]!.accelerators[0]!), count: 1 }]
    });
    expect(checkEnvironment(aboveLimit).valid).toBe(false);
    expect(() => parseHardwareGraph(aboveLimit)).toThrow("S2 model limit is 4096");
  });
});

describe("S2 node context command dialect", () => {
  const execute = (command: string) => {
    const { snapshot, instance } = fixture();
    return new NodeContextSimulator(snapshot, instance).execute(command);
  };

  it.each([
    "nvidia-smi",
    "nvidia-smi -L",
    "nvidia-smi -q",
    "nvidia-smi -q -i 0",
    "nvidia-smi --query-gpu=index,name,memory.total,utilization.gpu --format=csv,noheader,nounits",
    "nvidia-smi topo -m",
    "nvidia-smi topo -mp",
    "nvidia-smi topo -p2p",
    "nvidia-smi nvlink --status",
    "nvidia-smi nvlink --capabilities",
    "nvidia-smi nvlink --error-counters",
    "nvitop",
    "infraenv top",
    "infraenv topology",
    "infraenv bench hbm",
    "infraenv bench p2p",
    "infraenv bench collective",
    "infraenv bench storage"
  ])("supports %s with an explicit disclosure", (command) => {
    const result = execute(command);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("SIMULATED / S2");
  });

  it.each(["hbm", "p2p", "collective", "storage"])("reports theory/model/seed/assumptions for %s", (kind) => {
    const output = execute(`infraenv bench ${kind}`).stdout;
    expect(output).toContain(`${kind}.theory=`);
    expect(output).toContain(`${kind}.model=`);
    expect(output).toContain("seed=240803");
    expect(output).toContain("assumptions=");
  });

  it("rejects unsupported commands without claiming S3 fidelity", () => {
    const result = execute("sudo real-benchmark");
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("Unsupported S2 node command");
    expect(result.stderr).not.toContain("S3");
  });
});
