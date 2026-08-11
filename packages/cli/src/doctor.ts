import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export interface DockerProbe {
  available: boolean;
  version?: string;
  osType?: string;
  imagesReady?: boolean;
  reason?: string;
}

export type SpawnProbe = (command: string, args: string[]) => SpawnSyncReturns<string>;

const defaultProbe: SpawnProbe = (command, args) => spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 5000 });

export function probeDocker(spawnProbe: SpawnProbe = defaultProbe): DockerProbe {
  const result = spawnProbe("docker", ["version", "--format", "{{.Server.Version}}"]);
  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? (result.stderr.trim() || "Docker daemon did not respond.");
    return { available: false, reason };
  }
  const info = spawnProbe("docker", ["info", "--format", "{{.OSType}}"]);
  if (info.error || info.status !== 0) return { available: false, reason: info.error?.message ?? (info.stderr.trim() || "Docker info did not respond.") };
  const runtimeImage = spawnProbe("docker", ["image", "inspect", "infraenv/runtime:0.1.0-alpha.0"]);
  const sandboxImage = spawnProbe("docker", ["image", "inspect", "infraenv/sandbox:0.1.0-alpha.0"]);
  return { available: true, version: result.stdout.trim(), osType: info.stdout.trim(), imagesReady: runtimeImage.status === 0 && sandboxImage.status === 0 };
}

export function renderDoctor(probe = probeDocker()): { ok: boolean; text: string } {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  const nodeOk = nodeMajor >= 22;
  const dockerMajor = Number.parseInt(probe.version?.split(".")[0] ?? "0", 10);
  const dockerVersionOk = probe.available && dockerMajor >= 26;
  const linuxMode = probe.available && probe.osType === "linux";
  const imagesReady = probe.available && probe.imagesReady === true;
  const lines = [
    "InfraEnv doctor",
    "---------------",
    `${nodeOk ? "PASS" : "FAIL"} Node.js ${process.versions.node} (requires >=22)`,
    `${dockerVersionOk ? "PASS" : "FAIL"} Docker daemon${probe.version ? ` ${probe.version}` : ""} (requires >=26)`,
    `${linuxMode ? "PASS" : "FAIL"} Linux container mode${probe.osType ? ` (${probe.osType})` : ""}`,
    `${imagesReady ? "PASS" : "FAIL"} InfraEnv runtime and sandbox images`
  ];
  if (!probe.available) {
    lines.push("", "Docker Desktop is not running or is unreachable.", "Start Docker Desktop, wait until the engine is ready, then run `infraenv doctor` again.", "InfraEnv will not fall back to MinGW: labs require a real Linux Docker sandbox.");
    if (probe.reason) lines.push(`Detail: ${probe.reason.split(/\r?\n/)[0]}`);
  }
  if (probe.available && !dockerVersionOk) lines.push("", `Docker ${probe.version ?? "unknown"} is too old; install Docker Engine/Desktop 26 or newer.`);
  if (probe.available && !linuxMode) lines.push("", "Switch Docker Desktop to Linux containers; InfraEnv does not emulate Linux with MinGW.");
  if (probe.available && !imagesReady) lines.push("", "Build the local alpha images with `npm run docker:build`.");
  lines.push("", "No physical GPU is required. All cluster/GPU/performance data in the first lab is SIMULATED / S2.");
  return { ok: nodeOk && dockerVersionOk && linuxMode && imagesReady, text: lines.join("\n") };
}
