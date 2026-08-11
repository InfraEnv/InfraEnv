import { describe, expect, it } from "vitest";
import { SimulationEngine, findSlowWorkerLab } from "@infraenv/simulation";
import {
  deriveDirectCourseSteps,
  deriveDirectRuntimeCapabilities
} from "../apps/web-ui/src/direct-course-adapter.js";

function completion(engine: SimulationEngine): Map<string, boolean> {
  return new Map(deriveDirectCourseSteps(engine.snapshot()).map((step) => [step.id, step.complete]));
}

describe("Direct Runtime course adapter", () => {
  it("starts with only the three pre-attach host steps complete", () => {
    const steps = deriveDirectCourseSteps(new SimulationEngine().snapshot());

    expect(steps.slice(0, 3).map((step) => [step.id, step.complete])).toEqual([
      ["step:doctor", true],
      ["step:list-labs", true],
      ["step:start-lab", true]
    ]);
    expect(steps.slice(3).every((step) => !step.complete)).toBe(true);
  });

  it("derives every displayed command from the canonical LabDefinition", () => {
    const derived = deriveDirectCourseSteps(new SimulationEngine().snapshot());

    expect(derived.map(({ id, command }) => ({ id, command }))).toEqual(
      findSlowWorkerLab.steps.map(({ id, command }) => ({ id, command }))
    );
  });

  it("tracks observation, diagnosis, repair, and final validation as one closed loop", () => {
    const engine = new SimulationEngine();

    engine.observeCommand("nvidia-smi");
    for (const command of ["sinfo", "squeue", "infraenv nodes", "infraenv jobs"]) engine.observeCommand(command);
    expect(completion(engine).get("step:inspect-gpu-inventory")).toBe(true);
    expect(completion(engine).get("step:inspect-scheduler")).toBe(true);

    engine.observeCommand("infraenv metrics network");
    expect(completion(engine).get("step:network-metrics")).toBe(true);
    engine.observeCommand("infraenv metrics gpu");
    expect(completion(engine).get("step:gpu-metrics")).toBe(true);
    engine.observeCommand("infraenv inspect node03");
    expect(completion(engine).get("step:inspect-node03")).toBe(true);
    engine.observeCommand("infraenv diagnose");
    expect(completion(engine).get("step:diagnose")).toBe(true);

    engine.setHypothesis("gpu.overheating", "node03");
    expect(completion(engine).get("step:submit-diagnosis")).toBe(false);
    engine.setHypothesis("network.bandwidth_drop", "node03");
    expect(completion(engine).get("step:submit-diagnosis")).toBe(true);

    engine.clearFault("fault:node03-bandwidth");
    expect(completion(engine).get("step:clear-fault")).toBe(true);
    expect(completion(engine).get("step:final-submit")).toBe(false);

    engine.markPassed();
    expect(deriveDirectCourseSteps(engine.snapshot()).every((step) => step.complete)).toBe(true);
  });

  it("maps only the fault actions explicitly allowed by Direct Runtime", () => {
    expect(deriveDirectRuntimeCapabilities([])).toEqual([
      "control.pause",
      "control.resume",
      "control.reset"
    ]);
    expect(deriveDirectRuntimeCapabilities(["inject-listed-fault"])).toContain("fault.inject");
    expect(deriveDirectRuntimeCapabilities(["clear-listed-fault"])).toContain("fault.clear");
    expect(deriveDirectRuntimeCapabilities(["unrelated-action"])).not.toContain("fault.inject");
  });
});
