import { describe, expect, it } from "vitest";
import { checkLab, checkScenario } from "@infraenv/protocol";
import { findSlowWorkerLab, findSlowWorkerRuntimeScenario } from "@infraenv/simulation";

describe("content protocol", () => {
  it("accepts the built-in data and rejects executable or unknown fields", () => {
    expect(checkScenario(findSlowWorkerRuntimeScenario).valid).toBe(true);
    expect(checkLab(findSlowWorkerLab).valid).toBe(true);
    expect(checkScenario({ ...findSlowWorkerRuntimeScenario, lifecycleScript: "rm -rf /" }).valid).toBe(false);
  });
});
