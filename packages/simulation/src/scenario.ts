/** Public exports backed exclusively by the generated, checksummed curriculum profile. */
export {
  runtimeCurriculumProfile,
  findSlowWorkerLab,
  findSlowWorkerScenarioDocument
} from "./generated/curriculum.js";

import { normalizeScenarioFromProfile } from "./resolver.js";
import { findSlowWorkerScenarioDocument, runtimeCurriculumProfile } from "./generated/curriculum.js";

/** Stable course-v1 engine input resolved from canonical curriculum v2 assets. */
export const findSlowWorkerScenario = normalizeScenarioFromProfile(runtimeCurriculumProfile, findSlowWorkerScenarioDocument);
export const findSlowWorkerRuntimeScenario = findSlowWorkerScenario;
