import { describe, expect, it } from "vitest";
import { SimulationEngine, findSlowWorkerLab } from "@infraenv/simulation";
import { validateLab } from "@infraenv/validator";

describe("declarative lab validation", () => {
  it("distinguishes missing work, wrong target, active fault and complete recovery", () => {
    const engine = new SimulationEngine();
    expect(validateLab(findSlowWorkerLab, engine.snapshot()).passed).toBe(false);

    engine.observeCommand("infraenv metrics network");
    engine.observeCommand("infraenv metrics gpu");
    engine.observeCommand("infraenv inspect node03");
    engine.setHypothesis("network.bandwidth_drop", "node07");
    let result = validateLab(findSlowWorkerLab, engine.snapshot());
    expect(result.checks.find((check) => check.id === "validator:diagnosis-correct")?.passed).toBe(false);

    engine.setHypothesis("network.bandwidth_drop", "node03");
    result = validateLab(findSlowWorkerLab, engine.snapshot());
    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.id === "validator:fault-cleared")?.passed).toBe(false);

    engine.clearFault("fault:node03-bandwidth");
    result = validateLab(findSlowWorkerLab, engine.snapshot());
    expect(result.passed).toBe(true);
    expect(result.checks.every((check) => check.passed)).toBe(true);
  });
});
