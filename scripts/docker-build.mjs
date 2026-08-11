import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const builds = [
  ["infraenv/runtime:0.2.0-alpha.0", "docker/runtime-sidecar/Dockerfile"],
  ["infraenv/sandbox:0.2.0-alpha.0", "docker/sandbox/Dockerfile"]
];

for (const [tag, dockerfile] of builds) {
  console.log(`Building ${tag}...`);
  const result = spawnSync("docker", ["build", "--file", dockerfile, "--tag", tag, "."], { cwd: root, stdio: "inherit", windowsHide: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("Built InfraEnv runtime and sandbox images.");
