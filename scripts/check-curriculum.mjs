import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderRuntimeModule } from "./curriculum-codegen.mjs";

const read = (path) => readFile(resolve(path));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const raw = await read("vendor/curriculum/catalog.json");
const catalog = JSON.parse(raw.toString("utf8"));
const checksum = JSON.parse((await read("vendor/curriculum/checksum.json")).toString("utf8"));
const generated = await read("packages/simulation/src/generated/curriculum.ts");
const contentLicense = await read("vendor/curriculum/LICENSE-CONTENT");
const attribution = await read("vendor/curriculum/ATTRIBUTION.md");
const digest = sha256(raw);

if (checksum.digest !== digest) throw new Error(`Curriculum checksum mismatch: expected ${checksum.digest}, got ${digest}. Run npm run content:sync.`);
if (catalog.manifest?.contentVersion !== checksum.contentVersion) throw new Error("Curriculum contentVersion does not match checksum metadata.");
if (sha256(generated) !== checksum.generatedModuleDigest || generated.toString("utf8") !== renderRuntimeModule(catalog)) throw new Error("Generated simulation definitions drifted from the committed curriculum snapshot. Run npm run content:sync.");
if (sha256(contentLicense) !== checksum.contentLicenseDigest) throw new Error("CC BY 4.0 content license digest mismatch.");
if (sha256(attribution) !== checksum.attributionDigest) throw new Error("Curriculum attribution digest mismatch.");
if (catalog.labs?.[0]?.id !== "lab:find-slow-worker") throw new Error("Runtime curriculum snapshot does not contain lab:find-slow-worker.");
if (catalog.scenarios?.[0]?.cluster?.nodeCount !== 16 || catalog.scenarios?.[0]?.cluster?.gpusPerNode !== 8) throw new Error("Find Slow Worker topology must remain 16 nodes × 8 GPUs.");
if (catalog.scenarios?.[0]?.seed !== 240803) throw new Error("Runtime scenario seed drifted from the compiled curriculum profile.");
console.log(`Curriculum snapshot OK: ${catalog.manifest.contentVersion}; ${checksum.manifestIntegrityVerified} source assets; sha256 ${digest.slice(0, 12)}…`);
