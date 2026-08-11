import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findSlowWorkerLab,
  findSlowWorkerScenario,
  findSlowWorkerScenarioDocument,
  runtimeCurriculumProfile
} from "@infraenv/simulation";

describe("generated curriculum consumer", () => {
  it("exports definitions from the committed snapshot without a second hand-written copy", async () => {
    const catalog = JSON.parse(await readFile(resolve("vendor/curriculum/catalog.json"), "utf8")) as typeof runtimeCurriculumProfile;
    expect(runtimeCurriculumProfile).toEqual(catalog);
    expect(findSlowWorkerLab).toEqual(catalog.labs.find((item) => item.id === "lab:find-slow-worker"));
    const canonicalScenario = catalog.scenarios.find(
      (item) => item.id === findSlowWorkerLab.scenarioRef.id && item.version === findSlowWorkerLab.scenarioRef.version
    );
    expect(findSlowWorkerScenarioDocument).toEqual(canonicalScenario);
    expect(findSlowWorkerScenario).toMatchObject({
      id: findSlowWorkerLab.scenarioRef.id,
      version: findSlowWorkerLab.scenarioRef.version,
      cluster: { nodeCount: 16, gpusPerNode: 8, totalGpuCount: 128 }
    });
    expect(findSlowWorkerScenario).not.toHaveProperty("presetRef");
  });
});
