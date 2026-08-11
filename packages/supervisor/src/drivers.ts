import { spawnSync } from "node:child_process";
import type { EnvironmentInstance, EnvironmentSnapshot } from "@infraenv/shared";

export type RuntimeDriverMode = "model-only" | "docker";

export interface RuntimeDriverCapabilities {
  mode: RuntimeDriverMode;
  available: boolean;
  lowLevelAvailable?: boolean;
  lifecycleIntegrated?: boolean;
  docker: boolean;
  pty: boolean;
  networkIsolation: boolean;
  image?: string;
  reason?: string;
}

export interface RuntimeAllocation {
  containerIds: string[];
  networkNames: string[];
  ptyAvailable: boolean;
}

export interface RuntimeDriver {
  readonly mode: RuntimeDriverMode;
  capabilities(): Promise<RuntimeDriverCapabilities>;
  start(snapshot: EnvironmentSnapshot, instance: EnvironmentInstance): Promise<RuntimeAllocation>;
  stop(instance: EnvironmentInstance): Promise<void>;
}

export class RuntimeDriverError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "RuntimeDriverError"; }
}

export class ModelOnlyDriver implements RuntimeDriver {
  readonly mode = "model-only" as const;
  async capabilities(): Promise<RuntimeDriverCapabilities> {
    return {
      mode: this.mode,
      available: true,
      lowLevelAvailable: true,
      lifecycleIntegrated: true,
      docker: false,
      pty: false,
      networkIsolation: false,
      reason: "Deterministic S2 model only. No container, Linux PTY, or network namespace is provisioned."
    };
  }
  async start(): Promise<RuntimeAllocation> { return { containerIds: [], networkNames: [], ptyAvailable: false }; }
  async stop(): Promise<void> { /* No host resources exist in model-only mode. */ }
}

export interface DockerContainerDriverOptions {
  binary?: string;
  image?: string;
  command?: string[];
  timeoutMilliseconds?: number;
}

interface DockerResult { ok: boolean; stdout: string; stderr: string }

/** Uses only the Docker CLI. It never mounts the Docker socket or a host path. */
export class DockerContainerDriver implements RuntimeDriver {
  readonly mode = "docker" as const;
  readonly binary: string;
  readonly image: string;
  private readonly command: string[];
  private readonly timeoutMilliseconds: number;

  constructor(options: DockerContainerDriverOptions = {}) {
    this.binary = options.binary ?? "docker";
    this.image = options.image ?? "infraenv/sandbox:0.2.0-alpha.0";
    this.command = options.command ?? ["sleep", "infinity"];
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 10_000;
  }

  private run(args: string[], timeout = this.timeoutMilliseconds): DockerResult {
    const result = spawnSync(this.binary, args, { encoding: "utf8", timeout, windowsHide: true, shell: false });
    return {
      ok: !result.error && result.status === 0,
      stdout: (result.stdout ?? "").trim(),
      stderr: (result.stderr ?? result.error?.message ?? "").trim()
    };
  }

  async capabilities(): Promise<RuntimeDriverCapabilities> {
    const daemon = this.run(["version", "--format", "{{.Server.Version}}"], 5_000);
    if (!daemon.ok) return { mode: this.mode, available: false, lowLevelAvailable: false, lifecycleIntegrated: false, docker: false, pty: false, networkIsolation: false, image: this.image, reason: daemon.stderr || "Docker daemon is unavailable." };
    const image = this.run(["image", "inspect", this.image, "--format", "{{.Id}}"], 5_000);
    if (!image.ok) return { mode: this.mode, available: false, lowLevelAvailable: false, lifecycleIntegrated: false, docker: true, pty: false, networkIsolation: true, image: this.image, reason: `Sandbox image ${this.image} is not present locally; build it explicitly for the separate course lifecycle.` };
    return {
      mode: this.mode,
      available: false,
      lowLevelAvailable: true,
      lifecycleIntegrated: false,
      docker: true,
      pty: false,
      networkIsolation: true,
      image: this.image,
      reason: "The Sandbox image is present, but the general Sidecar + Sandbox + Workspace lifecycle and PTY broker are not integrated. Use the separate course lifecycle."
    };
  }

  async start(snapshot: EnvironmentSnapshot, instance: EnvironmentInstance): Promise<RuntimeAllocation> {
    const capability = await this.capabilities();
    if (!capability.available) throw new RuntimeDriverError("docker_unavailable", capability.reason ?? "Docker runtime is unavailable.");
    const suffix = instance.metadata.id.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(-48);
    const containerName = `infraenv-${suffix}`;
    const networkName = `${containerName}-net`;
    const network = this.run(["network", "create", "--internal", "--label", "dev.infraenv.managed=true", "--label", `dev.infraenv.instance=${instance.metadata.id}`, networkName]);
    if (!network.ok) throw new RuntimeDriverError("docker_network_failed", `Could not create isolated Docker network: ${network.stderr}`);
    const run = this.run([
      "run", "--detach", "--name", containerName,
      "--hostname", instance.activeNodeId,
      "--network", networkName,
      "--read-only",
      "--security-opt", "no-new-privileges:true",
      "--cap-drop", "ALL",
      "--pids-limit", "256",
      "--memory", "1024m",
      "--cpus", "2",
      "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=128m",
      "--tmpfs", "/run:rw,nosuid,nodev,noexec,size=32m",
      "--label", "dev.infraenv.managed=true",
      "--label", `dev.infraenv.instance=${instance.metadata.id}`,
      "--env", "INFRAENV_SIMULATION_LEVEL=S2",
      "--env", `INFRAENV_ENVIRONMENT_ID=${snapshot.metadata.environmentId}`,
      "--env", `INFRAENV_NODE_ID=${instance.activeNodeId}`,
      this.image,
      ...this.command
    ], 30_000);
    if (!run.ok) {
      this.run(["network", "rm", networkName]);
      throw new RuntimeDriverError("docker_start_failed", `Could not start sandbox container: ${run.stderr}`);
    }
    const running = this.run(["container", "inspect", run.stdout, "--format", "{{.State.Running}}"], 5_000);
    if (!running.ok || running.stdout !== "true") {
      this.run(["container", "rm", "--force", run.stdout], 10_000);
      this.run(["network", "rm", networkName], 10_000);
      throw new RuntimeDriverError("docker_self_test_failed", `Sandbox container did not remain running: ${running.stderr || running.stdout || "unknown state"}`);
    }
    return { containerIds: [run.stdout], networkNames: [networkName], ptyAvailable: true };
  }

  async stop(instance: EnvironmentInstance): Promise<void> {
    for (const containerId of instance.runtime?.containerIds ?? []) {
      const result = this.run(["container", "rm", "--force", containerId], 20_000);
      if (!result.ok && !/No such container/i.test(result.stderr)) throw new RuntimeDriverError("docker_stop_failed", `Could not remove sandbox container ${containerId}: ${result.stderr}`);
    }
    for (const networkName of instance.runtime?.networkNames ?? []) {
      const result = this.run(["network", "rm", networkName], 10_000);
      if (!result.ok && !/not found|No such network/i.test(result.stderr)) throw new RuntimeDriverError("docker_network_remove_failed", `Could not remove sandbox network ${networkName}: ${result.stderr}`);
    }
  }

  /** Arguments for a caller-owned interactive terminal; no shell interpolation is used. */
  ptyCommand(instance: EnvironmentInstance, shell = "/bin/bash"): { command: string; args: string[] } {
    const containerId = instance.runtime?.containerIds[0];
    if (!containerId) throw new RuntimeDriverError("pty_unavailable", "This instance has no Docker sandbox container.");
    return { command: this.binary, args: ["exec", "--interactive", "--tty", containerId, shell] };
  }
}
