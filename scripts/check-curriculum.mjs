import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderRuntimeModule } from "./curriculum-codegen.mjs";

const read = (path) => readFile(resolve(path));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const raw = await read("vendor/curriculum/catalog.json");
const catalog = JSON.parse(raw.toString("utf8"));
const checksum = JSON.parse((await read("vendor/curriculum/checksum.json")).toString("utf8"));
const profileManifestBytes = await read("vendor/curriculum/profile-manifest.json");
const profileManifest = JSON.parse(profileManifestBytes.toString("utf8"));
const generated = await read("packages/simulation/src/generated/curriculum.ts");

if (profileManifest.profile !== "runtime" || profileManifest.schemaVersion !== "2.0.0") throw new Error("Unsupported vendored curriculum profile manifest.");
for (const [relativePath, expected] of Object.entries(profileManifest.artifacts ?? {})) {
  const bytes = await read(`vendor/curriculum/${relativePath}`);
  const actual = `sha256-${sha256(bytes)}`;
  if (actual !== expected) throw new Error(`Vendored profile artifact mismatch for ${relativePath}: expected ${expected}, got ${actual}.`);
}
if (checksum.digest !== sha256(raw)) throw new Error("Curriculum catalog checksum mismatch. Run npm run content:sync.");
if (checksum.profileManifestDigest !== sha256(profileManifestBytes)) throw new Error("Curriculum profile manifest checksum mismatch.");
if (catalog.manifest?.contentVersion !== checksum.contentVersion || checksum.contentVersion !== profileManifest.contentVersion) throw new Error("Curriculum contentVersion metadata differs.");
if (sha256(generated) !== checksum.generatedModuleDigest || generated.toString("utf8") !== renderRuntimeModule(catalog)) throw new Error("Generated simulation definitions drifted from the vendored profile. Run npm run content:sync.");
if (sha256(await read("vendor/curriculum/LICENSE-CONTENT")) !== checksum.contentLicenseDigest) throw new Error("CC BY 4.0 content license digest mismatch.");
if (sha256(await read("vendor/curriculum/ATTRIBUTION.md")) !== checksum.attributionDigest) throw new Error("Curriculum attribution digest mismatch.");

const lab = catalog.labs?.find((item) => item.id === "lab:find-slow-worker");
if (!lab || lab.simulationLevel !== "S2") throw new Error("Runtime profile must contain the S2 lab:find-slow-worker.");
const scenario = catalog.scenarios?.find((item) => item.id === lab.scenarioRef?.id && item.version === lab.scenarioRef?.version);
if (!scenario || scenario.simulationLevel !== "S2") throw new Error("Lab scenarioRef does not resolve to an exact S2 Scenario version.");
const preset = catalog.presets?.find((item) => item.id === scenario.presetRef?.id && item.version === scenario.presetRef?.version);
if (!preset || preset.simulationLevel !== "S2") throw new Error("Scenario presetRef does not resolve to an exact S2 Preset version.");
let nodeCount = 0;
let totalGpuCount = 0;
for (const group of preset.systemGroups ?? []) {
  const system = catalog.systems?.find((item) => item.id === group.systemRef?.id && item.version === group.systemRef?.version);
  if (!system) throw new Error(`Preset System reference does not resolve: ${group.systemRef?.id}@${group.systemRef?.version}.`);
  const accelerator = catalog.accelerators?.find((item) => item.id === system.acceleratorRef?.id && item.version === system.acceleratorRef?.version);
  if (!accelerator) throw new Error(`System Accelerator reference does not resolve: ${system.acceleratorRef?.id}@${system.acceleratorRef?.version}.`);
  const perSystem = system.structure.acceleratorsPerComputeUnit * system.structure.computeUnitCount;
  nodeCount += group.count;
  totalGpuCount += group.count * perSystem;
}
for (const item of preset.fabrics ?? []) if (!catalog.fabrics?.some((fabric) => fabric.id === item.fabricRef?.id && fabric.version === item.fabricRef?.version)) throw new Error(`Preset Fabric reference does not resolve: ${item.fabricRef?.id}@${item.fabricRef?.version}.`);
if (preset.bootProfileRef && !catalog.bootProfiles?.some((item) => item.id === preset.bootProfileRef.id && item.version === preset.bootProfileRef.version)) throw new Error("Preset Boot reference does not resolve.");
if (nodeCount !== 16 || totalGpuCount !== 128) throw new Error(`Find Slow Worker topology must remain 16 nodes × 8 GPUs; got ${nodeCount} nodes and ${totalGpuCount} GPUs.`);
if (scenario.seed !== 240803 || scenario.version !== "2.0.0") throw new Error("Find Slow Worker scenario v2 seed drifted.");
if (!catalog.lessonDocuments?.some((document) => document.lessonId === lab.lessonId && document.locale === "zh-CN")) throw new Error("Find Slow Worker zh-CN lessonDocument is missing.");
if ((preset.optionalServices ?? []).some((service) => service.enabledByDefault)) throw new Error("Optional simulated services must remain disabled by default.");

console.log(`Curriculum snapshot OK: ${catalog.manifest.contentVersion}; ${checksum.verifiedArtifacts} compiled artifacts; sha256 ${checksum.digest.slice(0, 12)}…`);
