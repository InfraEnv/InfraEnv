import { describe, expect, it } from "vitest";
import { CommandSimulator, SimulationEngine } from "@infraenv/simulation";

describe("Find Slow Worker deterministic simulation", () => {
  it("produces identical causal state for the same seed and virtual time", () => {
    const first = new SimulationEngine(undefined, { sessionId: "session-a", startTimeSeconds: 45 }).snapshot();
    const second = new SimulationEngine(undefined, { sessionId: "session-b", startTimeSeconds: 45 }).snapshot();
    expect(first.nodes).toEqual(second.nodes);
    expect(first.training).toEqual(second.training);
    expect(first.faults).toEqual(second.faults);
    expect(first.nodes).toHaveLength(16);
    expect(first.nodes.flatMap((node) => node.gpus)).toHaveLength(128);
    expect(first.nodes[3]?.network.bandwidthGbps).toBe(20);
    expect(first.training.stepTimeMs).toBeGreaterThan(300);
  });

  it("restores the causal metrics after the fault is cleared", () => {
    const engine = new SimulationEngine();
    const degraded = engine.snapshot();
    const recovered = engine.clearFault("fault:node03-bandwidth");
    expect(degraded.nodes[3]?.health).toBe("degraded");
    expect(recovered.nodes[3]?.health).toBe("healthy");
    expect(recovered.nodes[3]?.network.bandwidthGbps).toBe(400);
    expect(recovered.training.stepTimeMs).toBeLessThan(200);
    expect(recovered.training.throughputSamplesPerSecond).toBeGreaterThan(degraded.training.throughputSamplesPerSecond);
  });

  it("activates the generated Scenario event exactly at its virtual timestamp", () => {
    const before = new SimulationEngine(undefined, { startTimeSeconds: 39 }).snapshot();
    const atEvent = new SimulationEngine(undefined, { startTimeSeconds: 40 }).snapshot();
    expect(before.faults[0]?.active).toBe(false);
    expect(before.nodes[3]?.network.bandwidthGbps).toBe(400);
    expect(atEvent.faults[0]?.active).toBe(true);
    expect(atEvent.nodes[3]?.network.bandwidthGbps).toBe(20);
  });

  it("labels every simulated command and avoids leaking the answer from diagnose", () => {
    const simulator = new CommandSimulator(new SimulationEngine());
    const result = simulator.execute("infraenv diagnose");
    expect(result.stdout).toContain("SIMULATED / S2");
    expect(result.stdout).not.toContain("node03");
    expect(result.stdout).not.toContain("network.bandwidth_drop");
  });
});
