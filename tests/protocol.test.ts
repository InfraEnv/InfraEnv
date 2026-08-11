import { describe, expect, it } from "vitest";
import { checkLab, checkScenario } from "@infraenv/protocol";
import { findSlowWorkerLab, findSlowWorkerScenario } from "@infraenv/simulation";

describe("content protocol", () => {
  it("accepts the built-in data and rejects executable or unknown fields", () => {
    expect(checkScenario(findSlowWorkerScenario).valid).toBe(true);
    expect(checkLab(findSlowWorkerLab).valid).toBe(true);
    expect(checkScenario({ ...findSlowWorkerScenario, lifecycleScript: "rm -rf /" }).valid).toBe(false);
  });
});
