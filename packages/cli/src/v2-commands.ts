import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Command } from "commander";
import type {
  EnvironmentCheckpoint,
  EnvironmentDocument,
  EnvironmentExportBundle,
  EnvironmentInstance,
  EnvironmentSnapshot
} from "@infraenv/shared";
import { apiSegment, resolveSupervisorConnection, SupervisorApiError, SupervisorClient, supervisorClient } from "./supervisor-client.js";
import {
  defaultSupervisorDataDir,
  loadSupervisorState,
  saveSupervisorState,
  updateSupervisorEnvironmentContext,
  type SupervisorState
} from "./supervisor-state.js";

interface NodeCommandOptions {
  instance?: string;
  node?: string;
}

interface ExecuteResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  [key: string]: unknown;
}

type StartSupervisor = (options: {
  host: string;
  port: number;
  dataDirectory: string;
  token: string;
}) => Promise<unknown> | unknown;

interface SupervisorModule {
  startSupervisor?: StartSupervisor;
}

export function addV2Commands(program: Command): void {
  program.option("--json", "emit machine-readable JSON where applicable");
  addSupervisorCommands(program);
  addEnvironmentCommands(program);
  addSnapshotCommands(program);
  addInstanceCommands(program);
  addCheckpointCommands(program);
  addNodeContextCommands(program);
  addUserRuntimeCommands(program);
  addTemplateCommands(program);
  addGraphAndStorageCommands(program);
}

function addSupervisorCommands(program: Command): void {
  const supervisor = program.command("supervisor").description("Run and inspect the host-local v0.2 Supervisor");

  supervisor.command("serve")
    .description("Serve the host control plane on loopback")
    .option("--host <host>", "listen host", "127.0.0.1")
    .option("--port <port>", "listen port", parsePort, 9090)
    .option("--data-dir <path>", "registry and checkpoint directory", defaultSupervisorDataDir())
    .action(async (options: { host: string; port: number; dataDir: string }) => {
      if (!isLoopback(options.host)) {
        throw new Error("The alpha Supervisor only listens on a loopback address. Use 127.0.0.1, localhost, or ::1.");
      }
      const configuredToken = process.env.INFRAENV_SUPERVISOR_TOKEN?.trim() || undefined;
      const token = configuredToken ?? randomBytes(32).toString("base64url");
      const packageName = "@infraenv/supervisor";
      const module = await import(packageName) as SupervisorModule;
      if (module.startSupervisor === undefined) {
        throw new Error("@infraenv/supervisor does not export startSupervisor(). Build the v0.2 Supervisor package first.");
      }
      await module.startSupervisor({ host: options.host, port: options.port, dataDirectory: resolve(options.dataDir), token });
      const apiUrl = `http://${options.host === "localhost" ? "127.0.0.1" : bracketIpv6(options.host)}:${options.port}/api/v1`;
      const state: SupervisorState = {
        apiUrl,
        dataDir: resolve(options.dataDir),
        pid: process.pid,
        startedAt: new Date().toISOString()
      };
      await saveSupervisorState(state);
      console.log(`InfraEnv Supervisor v0.2 is listening at ${apiUrl}`);
      if (configuredToken === undefined) console.log(`Process bearer token (printed once; valid for this Supervisor lifetime): ${token}`);
      else console.log("Using the process-local INFRAENV_SUPERVISOR_TOKEN (value not echoed)." );
      console.log("The token is not persisted. Set the same INFRAENV_SUPERVISOR_TOKEN in each client terminal for this Supervisor process.");
      console.log("Only the loopback URL and non-secret process metadata were saved to the local Supervisor state file.");
      console.log("Press Ctrl+C to stop. Environment data remains in the registry.");
    });

  supervisor.command("status").description("Check whether the Supervisor is reachable").action(async () => {
    const client = await supervisorClient();
    const result = await client.get<unknown>("/status", false);
    printValue(program, result);
  });

  supervisor.command("capabilities").description("Show actual local runtime capabilities and limitations").action(async () => {
    const client = await supervisorClient();
    const result = await client.get<unknown>("/capabilities", false);
    printValue(program, result);
  });
}

function addEnvironmentCommands(program: Command): void {
  const environment = program.command("environment").alias("env").description("Create and manage versioned Environment documents");

  environment.command("create <source>")
    .description("Create from a JSON file, or create <name> with template or hardware options")
    .option("--template <id>", "preset/template reference as id[@version]")
    .option("--nodes <count>", "number of modeled nodes", parsePositiveInteger)
    .option("--gpus-per-node <count>", "accelerators per node", parseNonNegativeInteger)
    .option("--gpu <id>", "accelerator profile or model name")
    .action(async (source: string, options: { template?: string; nodes?: number; gpusPerNode?: number; gpu?: string }) => {
    const client = await supervisorClient();
    const payload = await looksLikeExistingFile(source)
      ? { document: await readJsonFile<EnvironmentDocument>(source) }
      : createEnvironmentDraft(source, options, options.template === undefined ? undefined : await resolvePresetReference(client, options.template));
    printValue(program, await client.post<unknown>("/environments", payload));
  });

  environment.command("list").description("List active and stopped Environments").action(async () => {
    const client = await supervisorClient();
    printCollection(program, await client.get<unknown>("/environments"), "environments");
  });

  environment.command("show <environmentId>").description("Show one Environment document").action(async (environmentId: string) => {
    const client = await supervisorClient();
    printValue(program, await client.get<unknown>(`/environments/${apiSegment(environmentId)}?raw=true`));
  });

  environment.command("delete <environmentId>").description("Move an Environment to recoverable trash").action(async (environmentId: string) => {
    const client = await supervisorClient();
    printValue(program, await client.delete<unknown>(`/environments/${apiSegment(environmentId)}`));
  });

  environment.command("restore <environmentId>").description("Restore an Environment from trash").action(async (environmentId: string) => {
    const client = await supervisorClient();
    printValue(program, await client.post<unknown>(`/environments/${apiSegment(environmentId)}/restore`, {}));
  });

  environment.command("purge <environmentId>")
    .description("Permanently remove a trashed Environment")
    .option("--yes", "confirm permanent deletion")
    .action(async (environmentId: string, options: { yes?: boolean }) => {
      if (options.yes !== true) throw new Error("Purge is permanent. Re-run with --yes after checking the Environment ID.");
      const client = await supervisorClient();
      printValue(program, await client.delete<unknown>(`/environments/${apiSegment(environmentId)}/purge`));
    });

  environment.command("export <environmentId> <file>")
    .description("Export an Environment, snapshots and checkpoints as a portable bundle")
    .option("--force", "overwrite an existing output file")
    .action(async (environmentId: string, file: string, options: { force?: boolean }) => {
      const client = await supervisorClient();
      const bundle = await client.get<EnvironmentExportBundle>(`/environments/${apiSegment(environmentId)}/export`);
      const output = await writeJsonFile(file, bundle, options.force === true);
      console.log(`Exported ${environmentId} to ${output}.`);
    });

  environment.command("import <file>")
    .description("Verify and import a portable Environment bundle")
    .option("--replace", "replace an existing Environment with the same ID")
    .action(async (file: string, options: { replace?: boolean }) => {
      const bundle = await readJsonFile<EnvironmentExportBundle>(file);
      const client = await supervisorClient();
      printValue(program, await client.post<unknown>("/imports", { bundle, replace: options.replace === true }));
    });

  environment.command("snapshot <environmentId>")
    .description("Create an immutable deterministic snapshot")
    .option("--label <label>", "human-readable snapshot label")
    .action(async (environmentId: string, options: { label?: string }) => {
      const client = await supervisorClient();
      const body = options.label === undefined ? {} : { label: options.label };
      printValue(program, await client.post<EnvironmentSnapshot>(`/environments/${apiSegment(environmentId)}/snapshots`, body));
    });

  environment.command("start <environmentId>")
    .description("Start the Environment through the Supervisor")
    .option("--node <nodeId>", "initial node context")
    .option("--docker", "request Docker-backed lifecycle")
    .action(async (environmentId: string, options: { node?: string; docker?: boolean }) => {
      const client = await supervisorClient();
      const instance = await client.post<EnvironmentInstance>(`/environments/${apiSegment(environmentId)}/start?raw=true`, {
        ...(options.node === undefined ? {} : { nodeId: options.node }),
        ...(options.docker === true ? { docker: true } : {})
      });
      await updateSupervisorEnvironmentContext(environmentId, instance.metadata.id, instance.activeNodeId);
      printValue(program, instance);
    });

  environment.command("stop <environmentId>").description("Stop the active instance of an Environment").action(async (environmentId: string) => {
    const instance = await activeInstanceForEnvironment(environmentId);
    const client = await supervisorClient();
    printValue(program, await client.post<EnvironmentInstance>(`/instances/${apiSegment(instance.metadata.id)}/stop?raw=true`, {}));
  });

  environment.command("restart <environmentId>").description("Restart the active Environment instance").action(async (environmentId: string) => {
    const instance = await activeInstanceForEnvironment(environmentId);
    const client = await supervisorClient();
    const result = await client.post<EnvironmentInstance>(`/instances/${apiSegment(instance.metadata.id)}/restart?raw=true`, {});
    await updateSupervisorEnvironmentContext(environmentId, result.metadata.id, result.activeNodeId);
    printValue(program, result);
  });

  environment.command("reset <environmentId>").description("Reset an Environment instance to its deterministic snapshot").action(async (environmentId: string) => {
    const instance = await activeInstanceForEnvironment(environmentId);
    const client = await supervisorClient();
    const result = await client.post<EnvironmentInstance>(`/instances/${apiSegment(instance.metadata.id)}/reset?raw=true`, {});
    await updateSupervisorEnvironmentContext(environmentId, result.metadata.id, result.activeNodeId);
    printValue(program, result);
  });

  environment.command("apply <environmentId> <file>")
    .description("Apply an updated Environment document through optimistic registry validation")
    .option("--expected-updated-at <timestamp>", "reject if the stored Environment changed")
    .action(async (environmentId: string, file: string, options: { expectedUpdatedAt?: string }) => {
      const document = await readJsonFile<EnvironmentDocument>(file);
      if (document.metadata.id !== environmentId) {
        throw new Error(`Document ID ${document.metadata.id} does not match ${environmentId}.`);
      }
      const client = await supervisorClient();
      printValue(program, await client.put<unknown>(`/environments/${apiSegment(environmentId)}`, {
        document,
        ...(options.expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt: options.expectedUpdatedAt })
      }));
    });

  environment.command("clone <environmentId> <name>")
    .description("Clone an Environment under a new immutable ID namespace")
    .action(async (environmentId: string, name: string) => {
      const client = await supervisorClient();
      printValue(program, await client.post<unknown>(`/environments/${apiSegment(environmentId)}/clone`, { name }));
    });

  environment.command("use <environmentId>")
    .description("Select an Environment and its active instance as the CLI context")
    .option("--node <nodeId>", "select a node at the same time")
    .action(async (environmentId: string, options: { node?: string }) => {
      const instance = await activeInstanceForEnvironment(environmentId, true);
      if (instance === undefined) {
        await updateSupervisorEnvironmentContext(environmentId);
        console.log(`Active Environment context: ${environmentId} (not running)`);
        return;
      }
      const nodeId = options.node ?? instance.activeNodeId;
      const client = await supervisorClient();
      if (options.node !== undefined) await client.post(`/instances/${apiSegment(instance.metadata.id)}/node?raw=true`, { nodeId });
      await updateSupervisorEnvironmentContext(environmentId, instance.metadata.id, nodeId);
      console.log(`Active Environment context: ${environmentId}; instance=${instance.metadata.id}; node=${nodeId}`);
    });

  const environmentCheckpoint = environment.command("checkpoint").description("Manage checkpoints for this Environment");
  environmentCheckpoint.command("create <environmentId>")
    .option("--label <label>")
    .action(async (environmentId: string, options: { label?: string }) => {
      const instance = await activeInstanceForEnvironment(environmentId, true);
      const client = await supervisorClient();
      printValue(program, await client.post<EnvironmentCheckpoint>(`/environments/${apiSegment(environmentId)}/checkpoints`, {
        ...(instance === undefined ? {} : { instanceId: instance.metadata.id }),
        ...(options.label === undefined ? {} : { label: options.label })
      }));
    });
  environmentCheckpoint.command("list <environmentId>").action(async (environmentId: string) => {
    const client = await supervisorClient();
    printCollection(program, await client.get(`/environments/${apiSegment(environmentId)}/checkpoints`), "checkpoints");
  });
}

function addSnapshotCommands(program: Command): void {
  const snapshot = program.command("snapshot").description("Inspect immutable Environment snapshots");

  snapshot.command("list <environmentId>").action(async (environmentId: string) => {
    const client = await supervisorClient();
    printCollection(program, await client.get<unknown>(`/environments/${apiSegment(environmentId)}/snapshots`), "snapshots");
  });

  snapshot.command("show <snapshotId>").action(async (snapshotId: string) => {
    const client = await supervisorClient();
    printValue(program, await client.get<EnvironmentSnapshot>(`/snapshots/${apiSegment(snapshotId)}`));
  });
}

function addInstanceCommands(program: Command): void {
  const instance = program.command("instance").description("Start and control Environment instances");

  instance.command("start <environmentId>")
    .description("Start a deterministic S2 instance")
    .option("--snapshot <snapshotId>", "start an existing immutable snapshot")
    .option("--node <nodeId>", "initial node context")
    .option("--docker", "request the real Docker lifecycle capability")
    .action(async (environmentId: string, options: { snapshot?: string; node?: string; docker?: boolean }) => {
      const client = await supervisorClient();
      const request = {
        environmentId,
        ...(options.snapshot === undefined ? {} : { snapshotId: options.snapshot }),
        ...(options.node === undefined ? {} : { nodeId: options.node }),
        ...(options.docker === true ? { docker: true } : {})
      };
      const created = await client.post<EnvironmentInstance>("/instances?raw=true", request);
      await updateSupervisorEnvironmentContext(created.metadata.environmentId, created.metadata.id, created.activeNodeId);
      printValue(program, created);
    });

  instance.command("list").action(async () => {
    const client = await supervisorClient();
    printCollection(program, await client.get<unknown>("/instances?raw=true"), "instances");
  });

  instance.command("show <instanceId>").action(async (instanceId: string) => {
    const client = await supervisorClient();
    printValue(program, await client.get<EnvironmentInstance>(`/instances/${apiSegment(instanceId)}?raw=true`));
  });

  instance.command("stop <instanceId>").action(async (instanceId: string) => {
    const client = await supervisorClient();
    printValue(program, await client.post<EnvironmentInstance>(`/instances/${apiSegment(instanceId)}/stop?raw=true`, {}));
  });

  instance.command("exec <instanceId> <command...>")
    .description("Execute an allowlisted simulated node command")
    .option("--node <nodeId>", "node context for this command")
    .action(async (instanceId: string, command: string[], options: { node?: string }) => {
      await executeNodeCommand(program, command.join(" "), { instance: instanceId, ...(options.node === undefined ? {} : { node: options.node }) });
    });
}

function addCheckpointCommands(program: Command): void {
  const checkpoint = program.command("checkpoint").description("Capture and restore deterministic local learning state");

  checkpoint.command("create <environmentId>")
    .option("--instance <instanceId>", "capture this instance")
    .option("--label <label>", "checkpoint label")
    .action(async (environmentId: string, options: { instance?: string; label?: string }) => {
      const client = await supervisorClient();
      const body = {
        ...(options.instance === undefined ? {} : { instanceId: options.instance }),
        ...(options.label === undefined ? {} : { label: options.label })
      };
      printValue(program, await client.post<EnvironmentCheckpoint>(`/environments/${apiSegment(environmentId)}/checkpoints`, body));
    });

  checkpoint.command("list <environmentId>").action(async (environmentId: string) => {
    const client = await supervisorClient();
    printCollection(program, await client.get<unknown>(`/environments/${apiSegment(environmentId)}/checkpoints`), "checkpoints");
  });

  checkpoint.command("show <checkpointId>").action(async (checkpointId: string) => {
    const client = await supervisorClient();
    printValue(program, await client.get<EnvironmentCheckpoint>(`/checkpoints/${apiSegment(checkpointId)}`));
  });

  checkpoint.command("restore <checkpointId>").action(async (checkpointId: string) => {
    const client = await supervisorClient();
    const result = await client.post<unknown>(`/checkpoints/${apiSegment(checkpointId)}/restore`, {});
    printValue(program, result);
  });
}

function addNodeContextCommands(program: Command): void {
  const node = program.command("node").description("Select the active simulated node context");

  node.command("use <nodeId>")
    .option("--instance <instanceId>", "instance to select")
    .action(async (nodeId: string, options: { instance?: string }) => {
      const instanceId = await resolveInstanceId(options.instance);
      const client = await supervisorClient();
      const instance = await client.post<EnvironmentInstance>(`/instances/${apiSegment(instanceId)}/node?raw=true`, { nodeId });
      await updateSupervisorEnvironmentContext(instance.metadata.environmentId, instanceId, nodeId);
      console.log(`Active node context: ${nodeId} (${instanceId})`);
    });

  node.command("current").action(async () => {
    const state = await loadSupervisorState();
    if (state?.activeInstanceId === undefined || state.activeNodeId === undefined) {
      throw new Error("No node context is selected. Start an instance or run `infraenv node use <node> --instance <instance>`.");
    }
    printValue(program, { instanceId: state.activeInstanceId, nodeId: state.activeNodeId });
  });

  addNodeCommand(program, "top", "infraenv top", "Show simulated node pressure and accelerator utilization");
  addNodeCommand(program, "nvitop", "nvitop", "Render a simulated accelerator process view");
  addNodeCommand(program, "nvidia-smi", "nvidia-smi", "Render simulated NVIDIA-compatible inventory and metrics");
  addNodeCommand(program, "topology", "infraenv topology", "Show the current node hardware graph");

  program.command("bench [group]")
    .description("Run a deterministic simulated hbm, p2p, collective, storage, or all benchmark")
    .option("--instance <instanceId>", "target instance")
    .option("--node <nodeId>", "target node")
    .action(async (group: string | undefined, options: NodeCommandOptions) => {
      await executeNodeCommand(program, `infraenv bench ${group ?? "all"}`, options);
    });
}

function addUserRuntimeCommands(program: Command): void {
  program.command("shell <environmentId>")
    .description("Open a real PTY when the selected instance exposes that capability")
    .option("--node <nodeId>", "node context")
    .action(async (environmentId: string, options: { node?: string }) => {
      const instance = await activeInstanceForEnvironment(environmentId);
      const client = await supervisorClient();
      const capabilities = await client.get<unknown>("/capabilities", false);
      if (!hasCapability(capabilities, "terminal.host-attach")) {
        throw new Error(
          `Instance ${instance.metadata.id} has no secure host PTY attach capability. ` +
          "InfraEnv will not expose a container ID, reuse a browser terminal ticket, or report a model-only shell as successful."
        );
      }
      await client.post(`/instances/${apiSegment(instance.metadata.id)}/host-attach`, {
        ...(options.node === undefined ? {} : { nodeId: options.node })
      });
      throw new Error("The Supervisor accepted host attach but did not provide a CLI-owned PTY transport. Upgrade both CLI and Supervisor together.");
    });

  program.command("exec <environmentId> <command...>")
    .description("Run an allowlisted command on one node, or every modeled node with --all")
    .option("--node <nodeId>", "single node context")
    .option("--all", "execute once for every node in the immutable snapshot")
    .action(async (environmentId: string, commandParts: string[], options: { node?: string; all?: boolean }) => {
      const instance = await activeInstanceForEnvironment(environmentId);
      const command = commandParts.join(" ");
      const client = await supervisorClient();
      const nodeIds = options.all === true
        ? (await client.get<EnvironmentSnapshot>(`/snapshots/${apiSegment(instance.metadata.snapshotId)}`)).graph.nodes
          .filter((node) => node.kind === "node")
          .map((node) => node.id)
        : [options.node ?? instance.activeNodeId];
      let failed = false;
      for (const nodeId of nodeIds) {
        const result = await client.post<ExecuteResult>(`/instances/${apiSegment(instance.metadata.id)}/execute?raw=true`, { command, nodeId });
        if (nodeIds.length > 1) console.log(`== ${nodeId} ==`);
        if (result.stdout) console.log(result.stdout);
        if (result.stderr) console.error(result.stderr);
        if ((result.exitCode ?? 0) !== 0) failed = true;
      }
      if (failed) process.exitCode = 1;
    });

  program.command("webui [environmentId]")
    .alias("ui")
    .description("Ensure a foreground loopback Supervisor and launch its one-time Web UI URL")
    .option("--no-open", "print the URL without launching a browser")
    .action(async (environmentId: string | undefined, options: { open: boolean }) => {
      const selected = environmentId ?? (await loadSupervisorState(true))?.activeEnvironmentId;
      const owned = await ensureSupervisorForWebUi();
      const { client, foregroundOwned, processToken } = owned;
      const configuredBase = process.env.INFRAENV_WEB_UI_URL ?? `${new URL(client.connection.apiUrl).origin}/app/`;
      try {
        if (!isLoopbackHttpUrl(configuredBase)) {
          throw new Error(
            "The Web UI must use a loopback HTTP URL. Set INFRAENV_WEB_UI_URL only when overriding the Supervisor-owned /app/ endpoint."
          );
        }
        await assertWebUiReachable(configuredBase);
        const baseUrl = selected === undefined ? configuredBase : withQuery(configuredBase, "environment", selected);
        const launch = await client.post<unknown>("/auth/webui-launch", { baseUrl });
        const launchUrl = isRecord(launch) && typeof launch.url === "string" ? launch.url : undefined;
        if (launchUrl === undefined || !isSecureLoopbackLaunchUrl(launchUrl, baseUrl)) {
          throw new Error("Supervisor did not return a valid loopback Web UI URL with a one-time #launchToken fragment.");
        }
        console.log(launchUrl);
        if (options.open) await openUrl(launchUrl);
        if (foregroundOwned) {
          if (processToken !== undefined) {
            console.log(`Process bearer token (printed once; valid for this Supervisor lifetime): ${processToken}`);
            console.log(`PowerShell client setup: $env:INFRAENV_SUPERVISOR_TOKEN = '${processToken}'`);
          } else {
            console.log("Using the process-local INFRAENV_SUPERVISOR_TOKEN (value not echoed). Set the same value in each client terminal.");
          }
          console.log("The Supervisor is owned by this foreground command. Keep it running; press Ctrl+C after the Web UI session.");
        }
      } catch (error) {
        if (owned.close !== undefined) await owned.close();
        throw error;
      }
    });
}

function addTemplateCommands(program: Command): void {
  const template = program.command("template").description("Inspect curriculum-owned presets/templates");
  template.command("list").action(async () => {
    const client = await supervisorClient();
    printCollection(program, await client.get<unknown>("/presets"), "presets");
  });
  template.command("show <templateId>").action(async (templateId: string) => {
    const client = await supervisorClient();
    printValue(program, await client.get<unknown>(`/presets/${apiSegment(templateId)}`));
  });
}

function addGraphAndStorageCommands(program: Command): void {
  const device = program.command("device").description("Inspect devices from an immutable HardwareGraph snapshot");
  device.command("list [environmentId]")
    .option("--kind <kind>", "filter by HardwareGraph node kind")
    .action(async (environmentId: string | undefined, options: { kind?: string }) => {
      const snapshot = await latestSnapshotForEnvironment(await resolveEnvironmentId(environmentId));
      const devices = snapshot.graph.nodes.filter((node) => node.kind !== "cluster" && (options.kind === undefined || node.kind === options.kind));
      printCollection(program, devices, "devices");
    });
  device.command("show <deviceId> [environmentId]").action(async (deviceId: string, environmentId?: string) => {
    const snapshot = await latestSnapshotForEnvironment(await resolveEnvironmentId(environmentId));
    const match = snapshot.graph.nodes.find((node) => node.id === deviceId);
    if (match === undefined) throw new Error(`Device ${deviceId} is not present in snapshot ${snapshot.metadata.id}.`);
    printValue(program, match);
  });

  const link = program.command("link").description("Inspect topology links and modeled health");
  link.command("list [environmentId]")
    .option("--kind <kind>", "filter by link kind")
    .action(async (environmentId: string | undefined, options: { kind?: string }) => {
      const snapshot = await latestSnapshotForEnvironment(await resolveEnvironmentId(environmentId));
      const links = snapshot.graph.edges.filter((edge) => options.kind === undefined || edge.kind === options.kind);
      printCollection(program, links, "links");
    });
  link.command("show <linkId> [environmentId]").action(async (linkId: string, environmentId?: string) => {
    const snapshot = await latestSnapshotForEnvironment(await resolveEnvironmentId(environmentId));
    const match = snapshot.graph.edges.find((edge) => edge.id === linkId);
    if (match === undefined) throw new Error(`Link ${linkId} is not present in snapshot ${snapshot.metadata.id}.`);
    printValue(program, match);
  });

  const fault = program.commands.find((command) => command.name() === "fault")
    ?? program.command("fault").description("Inspect or change Environment-instance faults when supported");
  fault.description("Manage course-v1 and capability-gated Environment faults");
  fault.command("list [environmentId]").action(async (environmentId?: string) => {
    const instance = await activeInstanceForEnvironment(await resolveEnvironmentId(environmentId));
    const client = await supervisorClient();
    const detail = await client.get<unknown>(`/instances/${apiSegment(instance.metadata.id)}`);
    printCollection(program, detail, "faults");
  });
  fault.command("inject <faultId>").requiredOption("--environment <environmentId>").option("--target <target>").action(async (faultId: string, options: { environment: string; target?: string }) => {
    const instance = await activeInstanceForEnvironment(options.environment);
    const client = await supervisorClient();
    printValue(program, await client.post(`/instances/${apiSegment(instance.metadata.id)}/faults`, { faultId, ...(options.target === undefined ? {} : { target: options.target }) }));
  });
  const storage = program.command("storage").description("Inspect modeled storage and request optional storage capabilities");
  storage.command("list [environmentId]").action(async (environmentId?: string) => {
    const snapshot = await latestSnapshotForEnvironment(await resolveEnvironmentId(environmentId));
    printCollection(program, snapshot.document.spec.storage, "storage");
  });
  storage.command("show <storageId> [environmentId]").action(async (storageId: string, environmentId?: string) => {
    const snapshot = await latestSnapshotForEnvironment(await resolveEnvironmentId(environmentId));
    const match = snapshot.document.spec.storage.find((entry) => entry.id === storageId);
    if (match === undefined) throw new Error(`Storage endpoint ${storageId} is not present in snapshot ${snapshot.metadata.id}.`);
    printValue(program, match);
  });
  storage.command("connect <environmentId> <file>").description("Request a storage connection when the Supervisor advertises it").action(async (environmentId: string, file: string) => {
    const instance = await activeInstanceForEnvironment(environmentId);
    const client = await supervisorClient();
    printValue(program, await client.post(`/instances/${apiSegment(instance.metadata.id)}/storage/connect`, await readJsonFile(file)));
  });
  storage.command("load <environmentId> <source>").description("Request a storage load when the Supervisor advertises it").action(async (environmentId: string, source: string) => {
    const instance = await activeInstanceForEnvironment(environmentId);
    const client = await supervisorClient();
    printValue(program, await client.post(`/instances/${apiSegment(instance.metadata.id)}/storage/loads`, { source }));
  });
}

function addNodeCommand(program: Command, name: string, remoteCommand: string, description: string): void {
  program.command(name)
    .description(description)
    .option("--instance <instanceId>", "target instance")
    .option("--node <nodeId>", "target node")
    .action(async (options: NodeCommandOptions) => executeNodeCommand(program, remoteCommand, options));
}

async function executeNodeCommand(program: Command, command: string, options: NodeCommandOptions): Promise<void> {
  const state = await loadSupervisorState(true);
  const instanceId = await resolveInstanceId(options.instance ?? state?.activeInstanceId);
  const nodeId = options.node ?? state?.activeNodeId;
  const client = await supervisorClient();
  const result = await client.post<ExecuteResult>(`/instances/${apiSegment(instanceId)}/execute?raw=true`, {
    command,
    ...(nodeId === undefined ? {} : { nodeId })
  });
  if (result.stdout !== undefined && result.stdout.length > 0) console.log(result.stdout);
  if (result.stderr !== undefined && result.stderr.length > 0) console.error(result.stderr);
  if (result.exitCode !== undefined && result.exitCode !== 0) process.exitCode = result.exitCode;
  if (program.opts().json === true && result.stdout === undefined && result.stderr === undefined) printValue(program, result);
}

async function resolveInstanceId(explicit?: string): Promise<string> {
  if (explicit !== undefined) return explicit;
  const state = await loadSupervisorState(true);
  if (state?.activeInstanceId !== undefined) return state.activeInstanceId;

  const client = await supervisorClient();
  const value = await client.get<unknown>("/instances?raw=true");
  const active = collection(value, "instances")
    .filter((item) => {
      const state = instanceState(item);
      return instanceIdentifier(item) !== undefined && state !== undefined && !["stopped", "failed"].includes(state);
    });
  if (active.length === 1 && active[0] !== undefined) return instanceIdentifier(active[0])!;
  if (active.length === 0) throw new Error("No active Environment instance. Start one with `infraenv instance start <environment-id>`." );
  throw new Error("More than one Environment instance is active. Select one with --instance or `infraenv node use ... --instance ...`." );
}

async function activeInstanceForEnvironment(environmentId: string): Promise<EnvironmentInstance>;
async function activeInstanceForEnvironment(environmentId: string, optional: false): Promise<EnvironmentInstance>;
async function activeInstanceForEnvironment(environmentId: string, optional: true): Promise<EnvironmentInstance | undefined>;
async function activeInstanceForEnvironment(environmentId: string, optional = false): Promise<EnvironmentInstance | undefined> {
  const client = await supervisorClient();
  const response = await client.get<unknown>("/instances?raw=true");
  const matches = collection(response, "instances")
    .filter((item) => instanceEnvironmentIdentifier(item) === environmentId)
    .filter((item) => {
      const state = instanceState(item);
      return state !== undefined && !["stopped", "failed"].includes(state);
    });
  if (matches.length === 1) return canonicalInstance(client, matches[0]);
  if (matches.length > 1) throw new Error(`Supervisor invariant violation: more than one active instance exists for ${environmentId}.`);
  if (optional) return undefined;
  throw new Error(`Environment ${environmentId} has no active instance. Run \`infraenv env start ${environmentId}\`.`);
}

export async function clearSupervisorFault(environmentId: string, faultId: string): Promise<unknown> {
  const instance = await activeInstanceForEnvironment(environmentId);
  const client = await supervisorClient();
  return client.delete(`/instances/${apiSegment(instance.metadata.id)}/faults/${apiSegment(faultId)}`);
}

async function resolveEnvironmentId(explicit?: string): Promise<string> {
  if (explicit !== undefined) return explicit;
  const state = await loadSupervisorState(true);
  if (state?.activeEnvironmentId !== undefined) return state.activeEnvironmentId;
  throw new Error("No Environment context is selected. Pass an Environment ID or run `infraenv env use <environment-id>`." );
}

async function latestSnapshotForEnvironment(environmentId: string): Promise<EnvironmentSnapshot> {
  const client = await supervisorClient();
  const response = await client.get<unknown>(`/environments/${apiSegment(environmentId)}/snapshots`);
  const snapshots = collection(response, "snapshots")
    .filter((item): item is EnvironmentSnapshot => isRecord(item) && item.kind === "EnvironmentSnapshot")
    .sort((left, right) => right.metadata.revision - left.metadata.revision);
  const snapshot = snapshots[0];
  if (snapshot === undefined) {
    throw new Error(`Environment ${environmentId} has no snapshot. Run \`infraenv env snapshot ${environmentId}\` first.`);
  }
  return snapshot;
}

function createEnvironmentDraft(name: string, options: {
  template?: string;
  nodes?: number;
  gpusPerNode?: number;
  gpu?: string;
}, preset?: { id: string; version: string }): Record<string, unknown> {
  return {
    name,
    description: "Created by the InfraEnv v0.2 CLI. All capacity and performance values are SIMULATED / S2.",
    seed: stableSeed(name),
    source: preset === undefined ? { kind: "playground" } : { kind: "template", templateId: preset.id, version: preset.version },
    inventory: {
      ...(options.nodes === undefined ? {} : { rackCount: 1, nodesPerRack: options.nodes }),
      ...(options.gpusPerNode === undefined ? {} : { acceleratorsPerNode: options.gpusPerNode }),
      ...(options.gpu === undefined ? {} : { acceleratorModel: options.gpu })
    }
  };
}

async function resolvePresetReference(client: SupervisorClient, input: string): Promise<{ id: string; version: string }> {
  const response = await client.get<unknown>("/presets");
  const candidates = collection(response, "presets").flatMap((value) => {
    if (!isRecord(value)) return [];
    const id = entityIdentifier(value);
    const version = typeof value.version === "string"
      ? value.version
      : isRecord(value.metadata) && typeof value.metadata.version === "string" ? value.metadata.version : undefined;
    if (id === undefined || version === undefined) return [];
    const slug = typeof value.slug === "string" ? value.slug : id.split(":").at(-1);
    return [{ id, version, slug }];
  });
  const matches = candidates.filter((candidate) =>
    input === candidate.slug || input === candidate.id || input === `${candidate.id}@${candidate.version}`
  );
  if (matches.length === 0) {
    throw new Error(`Unknown template ${input}. Run \`infraenv template list\`; template slugs must resolve to a curriculum-owned preset ID and exact version.`);
  }
  if (matches.length > 1) {
    throw new Error(`Template ${input} is ambiguous. Use the exact canonical id@version shown by \`infraenv template list\`.`);
  }
  return { id: matches[0]!.id, version: matches[0]!.version };
}

function stableSeed(value: string): number {
  let seed = 2166136261;
  for (const character of value) seed = Math.imul(seed ^ character.codePointAt(0)!, 16777619) >>> 0;
  return seed;
}

async function looksLikeExistingFile(value: string): Promise<boolean> {
  if (/\.json$/i.test(value)) return true;
  try {
    await access(resolve(value));
    return true;
  } catch {
    return false;
  }
}

function entityIdentifier(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id === "string") return value.id;
  if (isRecord(value.metadata) && typeof value.metadata.id === "string") return value.metadata.id;
  return undefined;
}

function hasCapability(value: unknown, capability: string): boolean {
  if (!isRecord(value)) return false;
  if (Array.isArray(value.supported) && value.supported.includes(capability)) return true;
  if (isRecord(value.runtime) && Array.isArray(value.runtime.supported) && value.runtime.supported.includes(capability)) return true;
  return false;
}

function isSecureLoopbackLaunchUrl(value: string, expectedBase: string): boolean {
  try {
    const parsed = new URL(value);
    const expected = new URL(expectedBase);
    const fragment = new URLSearchParams(parsed.hash.replace(/^#/, ""));
    return isLoopbackHttpUrl(value) && parsed.origin === expected.origin && parsed.pathname === expected.pathname && Boolean(fragment.get("launchToken"));
  } catch {
    return false;
  }
}

function isLoopbackHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]" || parsed.hostname === "::1");
  } catch {
    return false;
  }
}

function withQuery(value: string, key: string, content: string): string {
  const url = new URL(value);
  url.searchParams.set(key, content);
  return url.toString();
}

async function assertWebUiReachable(value: string): Promise<void> {
  try {
    const response = await fetch(value, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    throw new Error(`The configured Web UI is not reachable at ${value}. No launch token was issued.`, { cause: error });
  }
}

async function ensureSupervisorForWebUi(): Promise<{ client: SupervisorClient; foregroundOwned: boolean; processToken?: string; close?: () => Promise<void> }> {
  const connection = await resolveSupervisorConnection();
  const existing = new SupervisorClient(connection);
  try {
    await existing.get("/health", false);
    return { client: existing, foregroundOwned: false };
  } catch (error) {
    if (error instanceof SupervisorApiError) throw error;
  }

  const endpoint = new URL(connection.apiUrl);
  if (!isLoopbackHttpUrl(endpoint.toString())) {
    throw new Error("Refusing to start an owned Supervisor on a non-loopback address.");
  }
  const port = endpoint.port.length > 0 ? Number(endpoint.port) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid Supervisor port in ${connection.apiUrl}.`);
  const configuredToken = process.env.INFRAENV_SUPERVISOR_TOKEN?.trim() || undefined;
  const token = configuredToken ?? randomBytes(32).toString("base64url");
  const packageName = "@infraenv/supervisor";
  const module = await import(packageName) as SupervisorModule;
  if (module.startSupervisor === undefined) throw new Error("@infraenv/supervisor does not export startSupervisor(). Build v0.2 first.");
  const running = await module.startSupervisor({
    host: endpoint.hostname === "localhost" ? "127.0.0.1" : endpoint.hostname.replace(/^\[|\]$/g, ""),
    port,
    dataDirectory: defaultSupervisorDataDir(),
    token
  });
  const owned = new SupervisorClient({ apiUrl: `${endpoint.origin}/api/v1`, token });
  await owned.get("/health", false);
  await saveSupervisorState({
    apiUrl: `${endpoint.origin}/api/v1`,
    dataDir: defaultSupervisorDataDir(),
    pid: process.pid,
    startedAt: new Date().toISOString()
  });
  let close: (() => Promise<void>) | undefined;
  if (isRecord(running) && typeof running.close === "function") {
    const closeOwned = running.close as () => Promise<void>;
    close = closeOwned;
    process.once("SIGINT", () => { void closeOwned().finally(() => { process.exitCode = 130; }); });
    process.once("SIGTERM", () => { void closeOwned().finally(() => { process.exitCode = 143; }); });
  }
  return {
    client: owned,
    foregroundOwned: true,
    ...(configuredToken === undefined ? { processToken: token } : {}),
    ...(close === undefined ? {} : { close })
  };
}

async function openUrl(url: string): Promise<void> {
  const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  await new Promise<void>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isEnvironmentInstance(value: unknown): value is EnvironmentInstance {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.kind === "EnvironmentInstance" && typeof record.state === "string" && typeof record.metadata === "object";
}

function instanceIdentifier(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.metadata) && typeof value.metadata.id === "string") return value.metadata.id;
  return typeof value.id === "string" ? value.id : undefined;
}

function instanceEnvironmentIdentifier(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.metadata) && typeof value.metadata.environmentId === "string") return value.metadata.environmentId;
  return typeof value.environmentId === "string" ? value.environmentId : undefined;
}

function instanceState(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.state === "string" ? value.state : typeof value.status === "string" ? value.status : undefined;
}

async function canonicalInstance(client: SupervisorClient, value: unknown): Promise<EnvironmentInstance> {
  if (isEnvironmentInstance(value)) return value;
  const id = instanceIdentifier(value);
  if (id === undefined) throw new Error("Supervisor returned an instance without an ID.");
  const raw = await client.get<unknown>(`/instances/${apiSegment(id)}?raw=true`);
  if (!isEnvironmentInstance(raw)) {
    throw new Error(`Supervisor did not expose canonical instance state for ${id}; upgrade the Supervisor and CLI together.`);
  }
  return raw;
}

function printValue(program: Command, value: unknown): void {
  if (value === undefined) {
    console.log(program.opts().json === true ? "null" : "OK");
    return;
  }
  if (typeof value === "string" && program.opts().json !== true) {
    console.log(value);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function printCollection(program: Command, value: unknown, preferredKey: string): void {
  if (program.opts().json === true) {
    printValue(program, value);
    return;
  }
  const items = collection(value, preferredKey);
  if (items.length === 0) {
    console.log("No records.");
    return;
  }
  for (const item of items) console.log(summaryLine(item));
}

function collection(value: unknown, preferredKey: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const preferred = record[preferredKey];
  if (Array.isArray(preferred)) return preferred;
  if (Array.isArray(record.items)) return record.items;
  return [];
}

function summaryLine(value: unknown): string {
  if (typeof value !== "object" || value === null) return String(value);
  const record = value as Record<string, unknown>;
  const metadata = typeof record.metadata === "object" && record.metadata !== null ? record.metadata as Record<string, unknown> : {};
  const id = metadata.id ?? record.id ?? "unknown";
  const name = metadata.name ?? record.name;
  const state = record.state ?? record.status;
  return [String(id), name === undefined ? undefined : String(name), state === undefined ? undefined : String(state)]
    .filter((part): part is string => part !== undefined)
    .join("  ");
}

async function readJsonFile<T>(file: string): Promise<T> {
  const path = resolve(file);
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    throw new Error(`Cannot read valid JSON from ${path}.`, { cause: error });
  }
}

async function writeJsonFile(file: string, value: unknown, force: boolean): Promise<string> {
  const path = resolve(file);
  if (!force) {
    try {
      await access(path);
      throw new Error(`Refusing to overwrite ${path}. Re-run with --force if this is intentional.`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Refusing to overwrite")) throw error;
    }
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port ${value}.`);
  return port;
}

function parsePositiveInteger(value: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`Expected a positive integer, received ${value}.`);
  return result;
}

function parseNonNegativeInteger(value: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`Expected a non-negative integer, received ${value}.`);
  return result;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function bracketIpv6(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}
