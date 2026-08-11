import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionId } from "@infraenv/shared";
import type { LocalSession } from "./session-file.js";

export const RUNTIME_IMAGE = "infraenv/runtime:0.1.0-alpha.0";
export const SANDBOX_IMAGE = "infraenv/sandbox:0.1.0-alpha.0";

export interface DockerRunResult { status: number; stdout: string; stderr: string }

export function docker(args: string[], options: { inherit?: boolean; timeout?: number } = {}): DockerRunResult {
  if (options.inherit) {
    const child = spawnSync("docker", args, { stdio: "inherit", windowsHide: true, timeout: options.timeout });
    return { status: child.status ?? 1, stdout: "", stderr: child.error?.message ?? "" };
  }
  const child = spawnSync("docker", args, { encoding: "utf8", windowsHide: true, timeout: options.timeout ?? 30_000 });
  return { status: child.status ?? 1, stdout: child.stdout?.trim() ?? "", stderr: child.stderr?.trim() ?? child.error?.message ?? "" };
}

export function securityArguments(kind: "runtime" | "sandbox"): string[] {
  const memory = kind === "runtime" ? "768m" : "1024m";
  const cpus = kind === "runtime" ? "2" : "2";
  return [
    "--read-only",
    "--security-opt", "no-new-privileges:true",
    "--cap-drop", "ALL",
    "--pids-limit", "256",
    "--memory", memory,
    "--cpus", cpus,
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=128m"
  ];
}

export function interactiveDockerArguments(inputIsTTY = Boolean(process.stdin.isTTY), outputIsTTY = Boolean(process.stdout.isTTY)): string[] {
  return inputIsTTY && outputIsTTY ? ["-it"] : ["-i"];
}

function assertDocker(result: DockerRunResult, action: string): string {
  if (result.status !== 0) throw new Error(`${action} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

export function repoRoot(): string {
  return process.env.INFRAENV_REPO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

export function curriculumChecksum(): string {
  try {
    const metadata = JSON.parse(readFileSync(resolve(repoRoot(), "vendor/curriculum/checksum.json"), "utf8")) as { digest?: string };
    if (!metadata.digest) throw new Error("missing digest");
    return `sha256-${metadata.digest}`;
  } catch {
    throw new Error("Generated curriculum checksum is missing. Run `npm run content:check` and `npm run content:sync` if necessary.");
  }
}

export function ensureImages(): void {
  for (const image of [RUNTIME_IMAGE, SANDBOX_IMAGE]) {
    if (docker(["image", "inspect", image]).status !== 0) {
      throw new Error(`Required image ${image} is not built. From ${repoRoot()}, run \`npm run docker:build\`.`);
    }
  }
}

export function startDockerSession(): { session: LocalSession; sandboxToken: string } {
  ensureImages();
  const sessionId = createSessionId();
  const suffix = sessionId.slice(-8).replace(/[^a-z0-9]/g, "");
  const network = `infraenv-${suffix}`;
  const hostNetwork = `infraenv-host-${suffix}`;
  const runtimeContainer = `infraenv-runtime-${suffix}`;
  const sandboxContainer = `infraenv-sandbox-${suffix}`;
  const progressVolume = `infraenv-progress-${suffix}`;
  const hostToken = randomBytes(32).toString("base64url");
  const sandboxToken = randomBytes(32).toString("base64url");
  const uiLaunchToken = randomBytes(32).toString("base64url");

  const runtimeArgs = [
    "run", "-d", "--name", runtimeContainer,
    "--network", hostNetwork,
    "--network", network,
    ...securityArguments("runtime"),
    "--tmpfs", "/run:rw,nosuid,size=16m",
    "--mount", `type=volume,source=${progressVolume},target=/data`,
    "-e", "INFRAENV_PORT=8080",
    "-e", "INFRAENV_UI_ROOT=/opt/infraenv/ui",
    "-e", "INFRAENV_PROGRESS_FILE=/data/progress.jsonl",
    "-e", `INFRAENV_SESSION_ID=${sessionId}`,
    "-e", `INFRAENV_HOST_TOKEN=${hostToken}`,
    "-e", `INFRAENV_SANDBOX_TOKEN=${sandboxToken}`,
    "-e", `INFRAENV_UI_LAUNCH_TOKEN=${uiLaunchToken}`,
    "-e", `INFRAENV_CURRICULUM_CHECKSUM=${curriculumChecksum()}`,
    "-p", "127.0.0.1:0:8080",
    RUNTIME_IMAGE
  ];
  try {
    assertDocker(docker(["network", "create", "--internal", network]), "Create internal session network");
    assertDocker(docker(["network", "create", hostNetwork]), "Create host bridge network");
    assertDocker(docker(["volume", "create", progressVolume]), "Create progress volume");
    assertDocker(docker(runtimeArgs), "Start runtime sidecar");
    const portOutput = assertDocker(docker(["port", runtimeContainer, "8080/tcp"]), "Resolve runtime port");
    const port = portOutput.match(/:(\d+)$/)?.[1];
    if (!port) throw new Error(`Could not parse loopback port from: ${portOutput}`);
    return {
      session: {
        sessionId,
        runtimeContainer,
        sandboxContainer,
        network,
        hostNetwork,
        progressVolume,
        apiUrl: `http://127.0.0.1:${port}/v1`,
        hostToken,
        uiLaunchToken,
        startedAt: new Date().toISOString()
      },
      sandboxToken
    };
  } catch (error) {
    void docker(["rm", "-f", runtimeContainer]);
    void docker(["network", "rm", network]);
    void docker(["network", "rm", hostNetwork]);
    void docker(["volume", "rm", progressVolume]);
    throw error;
  }
}

export function runSandbox(session: LocalSession, sandboxToken: string): Promise<number> {
  const args = [
    "run", "--rm", ...interactiveDockerArguments(), "--name", session.sandboxContainer,
    "--network", session.network,
    ...securityArguments("sandbox"),
    "--tmpfs", "/home/learner:rw,nosuid,size=256m,uid=10001,gid=10001,mode=0755",
    "-e", `INFRAENV_API_URL=http://${session.runtimeContainer}:8080/v1`,
    "-e", `INFRAENV_SANDBOX_TOKEN=${sandboxToken}`,
    "-e", "INFRAENV_SIMULATION_LEVEL=S2",
    "--hostname", "learner-console",
    SANDBOX_IMAGE
  ];
  const child = spawn("docker", args, { stdio: "inherit", windowsHide: true });
  return new Promise<number>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolvePromise(code ?? 1));
  });
}

export function stopDockerSession(session: LocalSession): void {
  void docker(["rm", "-f", session.sandboxContainer]);
  void docker(["stop", "--time", "10", session.runtimeContainer], { timeout: 15_000 });
  void docker(["rm", session.runtimeContainer]);
  void docker(["network", "rm", session.network]);
  void docker(["network", "rm", session.hostNetwork]);
  // The named progress volume intentionally remains local so learning JSONL survives cleanup.
}

export function resetDockerSession(session: LocalSession): DockerRunResult {
  return docker(["restart", session.runtimeContainer]);
}
