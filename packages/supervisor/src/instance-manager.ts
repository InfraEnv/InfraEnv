import { randomUUID } from "node:crypto";
import type {
  CheckpointId,
  CommandResult,
  EnvironmentId,
  EnvironmentInstance,
  EnvironmentInstanceId,
  EnvironmentSnapshot,
  EnvironmentSnapshotId
} from "@infraenv/shared";
import { NodeContextSimulator } from "@infraenv/simulation";
import { DockerContainerDriver, ModelOnlyDriver, type RuntimeDriver, type RuntimeDriverCapabilities } from "./drivers.js";
import { RegistryError, registryIntegrity } from "./registry.js";
import type { EnvironmentRegistry } from "./registry.js";

export interface StartEnvironmentInstanceOptions {
  snapshotId?: EnvironmentSnapshotId;
  nodeId?: string;
  docker?: boolean;
}

export interface EnvironmentInstanceManagerOptions {
  registry: EnvironmentRegistry;
  modelDriver?: RuntimeDriver;
  dockerDriver?: RuntimeDriver;
  maximumActiveInstances?: number;
  now?: () => Date;
  idFactory?: () => string;
}

export class InstanceManagerError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 409, readonly details?: unknown) {
    super(message);
    this.name = "InstanceManagerError";
  }
}

function isActive(instance: EnvironmentInstance): boolean {
  return instance.state !== "stopped" && instance.state !== "failed";
}

export class EnvironmentInstanceManager {
  readonly maximumActiveInstances: number;
  private readonly registry: EnvironmentRegistry;
  private readonly modelDriver: RuntimeDriver;
  private readonly dockerDriver: RuntimeDriver;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private operations: Promise<void> = Promise.resolve();

  constructor(options: EnvironmentInstanceManagerOptions) {
    this.registry = options.registry;
    this.modelDriver = options.modelDriver ?? new ModelOnlyDriver();
    this.dockerDriver = options.dockerDriver ?? new DockerContainerDriver();
    this.maximumActiveInstances = options.maximumActiveInstances ?? 4;
    if (!Number.isInteger(this.maximumActiveInstances) || this.maximumActiveInstances < 1) throw new Error("maximumActiveInstances must be a positive integer.");
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation, operation);
    this.operations = result.then(() => undefined, () => undefined);
    return result;
  }

  async capabilities(): Promise<{ maximumActiveInstances: number; drivers: RuntimeDriverCapabilities[] }> {
    return { maximumActiveInstances: this.maximumActiveInstances, drivers: await Promise.all([this.modelDriver.capabilities(), this.dockerDriver.capabilities()]) };
  }

  async start(environmentId: EnvironmentId, options: StartEnvironmentInstanceOptions = {}): Promise<EnvironmentInstance> {
    return this.serialize(async () => {
      if (options.docker === true) {
        throw new InstanceManagerError(
          "capability_unavailable",
          "Generic Docker Playground instances are unavailable in v0.2 because the current driver does not provision the required Runtime Sidecar and persistent workspace volume. Course-v1 Docker labs remain available through `infraenv lab start`.",
          501,
          { capability: "environment.docker-start", status: "unavailable" }
        );
      }
      await this.registry.getEnvironment(environmentId);
      const instances = await this.registry.listInstances();
      const active = instances.filter(isActive);
      if (active.length >= this.maximumActiveInstances) throw new InstanceManagerError("instance_limit", `At most ${this.maximumActiveInstances} environment instances may be active.`, 429);
      if (active.some((instance) => instance.metadata.environmentId === environmentId)) throw new InstanceManagerError("environment_already_active", `Environment ${environmentId} already has an active instance.`);
      const snapshot = await this.resolveSnapshot(environmentId, options.snapshotId);
      const nodeId = options.nodeId ?? snapshot.graph.nodes.find((node) => node.kind === "node")?.id;
      if (!nodeId || !snapshot.graph.nodes.some((node) => node.kind === "node" && node.id === nodeId)) throw new InstanceManagerError("node_not_found", `Node ${nodeId ?? "<none>"} is not present in snapshot ${snapshot.metadata.id}.`, 422);
      const driver = options.docker ? this.dockerDriver : this.modelDriver;
      const capability = await driver.capabilities();
      if (!capability.available) throw new InstanceManagerError("runtime_unavailable", capability.reason ?? `${driver.mode} runtime is unavailable.`, 503, capability);
      const timestamp = this.now().toISOString();
      const instance: EnvironmentInstance = {
        apiVersion: "infraenv.io/v1alpha1",
        kind: "EnvironmentInstance",
        metadata: { id: `instance:${this.idFactory()}` as EnvironmentInstanceId, environmentId, snapshotId: snapshot.metadata.id, createdAt: timestamp, updatedAt: timestamp },
        state: "provisioning",
        activeNodeId: nodeId,
        boot: snapshot.boot
      };
      await this.registry.saveInstance(instance);
      try {
        await this.transition(instance, "booting");
        const allocation = await driver.start(snapshot, instance);
        instance.runtime = allocation;
        await this.transition(instance, "self-testing");
        new NodeContextSimulator(snapshot, instance, nodeId).execute("infraenv top");
        await this.transition(instance, "ready");
        return structuredClone(instance);
      } catch (error) {
        instance.state = "failed";
        instance.error = error instanceof Error ? error.message : String(error);
        instance.metadata.updatedAt = this.now().toISOString();
        await this.registry.saveInstance(instance);
        throw new InstanceManagerError("instance_start_failed", instance.error, 503);
      }
    });
  }

  async list(): Promise<EnvironmentInstance[]> { return this.registry.listInstances(); }
  async get(instanceId: EnvironmentInstanceId): Promise<EnvironmentInstance> { return this.registry.getInstance(instanceId); }

  async stop(instanceId: EnvironmentInstanceId): Promise<EnvironmentInstance> {
    return this.serialize(async () => {
      const instance = await this.registry.getInstance(instanceId);
      if (instance.state === "stopped") return instance;
      if (instance.state === "failed" && !instance.runtime?.containerIds.length) return instance;
      await this.transition(instance, "stopping");
      const driver = instance.runtime?.containerIds.length ? this.dockerDriver : this.modelDriver;
      try {
        await driver.stop(instance);
        instance.runtime = { containerIds: [], networkNames: [], ptyAvailable: false };
        await this.transition(instance, "stopped");
      } catch (error) {
        instance.state = "failed";
        instance.error = error instanceof Error ? error.message : String(error);
        instance.metadata.updatedAt = this.now().toISOString();
        await this.registry.saveInstance(instance);
        throw new InstanceManagerError("instance_stop_failed", instance.error, 503);
      }
      return instance;
    });
  }

  async selectNode(instanceId: EnvironmentInstanceId, nodeId: string): Promise<EnvironmentInstance> {
    return this.serialize(async () => {
      const instance = await this.readyInstance(instanceId);
      const snapshot = await this.registry.getSnapshot(instance.metadata.snapshotId);
      const simulator = new NodeContextSimulator(snapshot, instance);
      simulator.useNode(nodeId);
      instance.activeNodeId = nodeId;
      instance.metadata.updatedAt = this.now().toISOString();
      await this.registry.saveInstance(instance);
      return instance;
    });
  }

  async control(instanceId: EnvironmentInstanceId, action: "pause" | "resume" | "reset"): Promise<EnvironmentInstance> {
    return this.serialize(async () => {
      const instance = await this.registry.getInstance(instanceId);
      if (action === "pause") {
        if (instance.state !== "ready") throw new InstanceManagerError("invalid_instance_transition", `Cannot pause an instance in ${instance.state} state.`);
        await this.transition(instance, "paused");
      } else if (action === "resume") {
        if (instance.state !== "paused") throw new InstanceManagerError("invalid_instance_transition", `Cannot resume an instance in ${instance.state} state.`);
        await this.transition(instance, "ready");
      } else {
        if (instance.state !== "ready" && instance.state !== "paused") throw new InstanceManagerError("invalid_instance_transition", `Cannot reset an instance in ${instance.state} state.`);
        const snapshot = await this.registry.getSnapshot(instance.metadata.snapshotId);
        const firstNode = snapshot.graph.nodes.find((node) => node.kind === "node")?.id;
        if (!firstNode) throw new InstanceManagerError("node_not_found", "Snapshot has no runnable node.", 422);
        instance.activeNodeId = firstNode;
        delete instance.error;
        await this.transition(instance, "self-testing");
        new NodeContextSimulator(snapshot, instance, firstNode).execute("infraenv top");
        await this.transition(instance, "ready");
      }
      return instance;
    });
  }

  async execute(instanceId: EnvironmentInstanceId, command: string, nodeId?: string): Promise<{ result: CommandResult; nodeId: string }> {
    const instance = await this.readyInstance(instanceId);
    const snapshot = await this.registry.getSnapshot(instance.metadata.snapshotId);
    const simulator = new NodeContextSimulator(snapshot, instance, nodeId ?? instance.activeNodeId);
    return { result: simulator.execute(command), nodeId: simulator.currentNode() };
  }

  async createCheckpoint(instanceId: EnvironmentInstanceId, label?: string, payload?: Record<string, unknown>) {
    const instance = await this.readyInstance(instanceId);
    return this.registry.createCheckpoint(instance.metadata.environmentId, { instanceId, ...(label ? { label } : {}), ...(payload ? { payload } : {}) });
  }

  async restoreCheckpoint(checkpointId: CheckpointId, options: { docker?: boolean } = {}): Promise<EnvironmentInstance> {
    const checkpoint = await this.registry.getCheckpoint(checkpointId);
    return this.start(checkpoint.metadata.environmentId, { snapshotId: checkpoint.snapshotId, nodeId: checkpoint.activeNodeId, ...(options.docker === undefined ? {} : { docker: options.docker }) });
  }

  async restoreCheckpointInto(instanceId: EnvironmentInstanceId, checkpointId: CheckpointId): Promise<EnvironmentInstance> {
    return this.serialize(async () => {
      const instance = await this.registry.getInstance(instanceId);
      if (instance.state !== "ready" && instance.state !== "paused") throw new InstanceManagerError("instance_not_ready", `Instance ${instanceId} is ${instance.state}.`);
      const checkpoint = await this.registry.getCheckpoint(checkpointId);
      if (checkpoint.metadata.environmentId !== instance.metadata.environmentId) throw new InstanceManagerError("checkpoint_environment_mismatch", "Checkpoint belongs to another environment.");
      const snapshot = await this.registry.getSnapshot(checkpoint.snapshotId);
      if (!snapshot.graph.nodes.some((node) => node.kind === "node" && node.id === checkpoint.activeNodeId)) throw new InstanceManagerError("checkpoint_node_missing", "Checkpoint active node is not present in its snapshot.", 422);
      await this.transition(instance, "reconciling");
      instance.metadata.snapshotId = checkpoint.snapshotId;
      instance.activeNodeId = checkpoint.activeNodeId;
      delete instance.error;
      await this.transition(instance, "ready");
      return instance;
    });
  }

  async reconcileDefinition(instanceId: EnvironmentInstanceId): Promise<EnvironmentInstance> {
    return this.serialize(async () => {
      const instance = await this.registry.getInstance(instanceId);
      if (instance.state !== "ready" && instance.state !== "paused") throw new InstanceManagerError("instance_not_ready", `Instance ${instanceId} is ${instance.state}.`);
      if (instance.runtime?.containerIds.length) throw new InstanceManagerError("reconcile_unavailable_for_docker", "Definition reconciliation is available only for model-only instances in v0.2.", 501);
      const latest = await this.registry.latestSnapshot(instance.metadata.environmentId);
      if (!latest || latest.metadata.id === instance.metadata.snapshotId) return instance;
      const previousSnapshotId = instance.metadata.snapshotId;
      const previousNodeId = instance.activeNodeId;
      const previousState = instance.state;
      const nextNode = latest.graph.nodes.some((node) => node.kind === "node" && node.id === previousNodeId)
        ? previousNodeId
        : latest.graph.nodes.find((node) => node.kind === "node")?.id;
      if (!nextNode) throw new InstanceManagerError("node_not_found", "The staged snapshot has no runnable node.", 422);
      try {
        await this.transition(instance, "reconciling");
        const candidate = structuredClone(instance);
        candidate.metadata.snapshotId = latest.metadata.id;
        candidate.activeNodeId = nextNode;
        new NodeContextSimulator(latest, candidate, nextNode).execute("infraenv top");
        instance.metadata.snapshotId = latest.metadata.id;
        instance.activeNodeId = nextNode;
        delete instance.error;
        await this.transition(instance, previousState);
        return instance;
      } catch (error) {
        instance.metadata.snapshotId = previousSnapshotId;
        instance.activeNodeId = previousNodeId;
        instance.state = previousState;
        instance.error = `Reconcile failed; previous definition remains active: ${error instanceof Error ? error.message : String(error)}`;
        instance.metadata.updatedAt = this.now().toISOString();
        await this.registry.saveInstance(instance);
        throw new InstanceManagerError("definition_reconcile_failed", instance.error, 422);
      }
    });
  }

  /** Marks stale non-terminal records after a supervisor restart; it never claims their host resources survived. */
  async reconcilePersistedInstances(): Promise<EnvironmentInstance[]> {
    const instances = await this.registry.listInstances();
    const reconciled: EnvironmentInstance[] = [];
    for (const instance of instances.filter(isActive)) {
      instance.state = "failed";
      instance.error = "Supervisor restarted; the ephemeral runtime allocation cannot be proven active and must be started again.";
      instance.metadata.updatedAt = this.now().toISOString();
      await this.registry.saveInstance(instance);
      reconciled.push(instance);
    }
    return reconciled;
  }

  private async resolveSnapshot(environmentId: EnvironmentId, snapshotId?: EnvironmentSnapshotId): Promise<EnvironmentSnapshot> {
    if (snapshotId) {
      const snapshot = await this.registry.getSnapshot(snapshotId);
      if (snapshot.metadata.environmentId !== environmentId) throw new InstanceManagerError("snapshot_environment_mismatch", "Snapshot belongs to another environment.", 409);
      return snapshot;
    }
    const [latest, current] = await Promise.all([this.registry.latestSnapshot(environmentId), this.registry.getEnvironment(environmentId)]);
    if (latest && registryIntegrity.checksum(latest.document) === registryIntegrity.checksum(current)) return latest;
    return this.registry.createSnapshot(environmentId, latest ? "Updated definition snapshot" : "Automatic start snapshot");
  }

  private async readyInstance(instanceId: EnvironmentInstanceId): Promise<EnvironmentInstance> {
    let instance: EnvironmentInstance;
    try { instance = await this.registry.getInstance(instanceId); }
    catch (error) { if (error instanceof RegistryError) throw new InstanceManagerError(error.code, error.message, error.statusCode); throw error; }
    if (instance.state !== "ready" && instance.state !== "paused") throw new InstanceManagerError("instance_not_ready", `Instance ${instanceId} is ${instance.state}.`);
    return instance;
  }

  private async transition(instance: EnvironmentInstance, state: EnvironmentInstance["state"]): Promise<void> {
    instance.state = state;
    instance.metadata.updatedAt = this.now().toISOString();
    await this.registry.saveInstance(instance);
  }
}

export { EnvironmentInstanceManager as InstanceManager };
