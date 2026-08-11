import { createHash, randomUUID } from "node:crypto";
import { checkEnvironment } from "@infraenv/protocol";
import type {
  CheckpointId,
  EnvironmentCheckpoint,
  EnvironmentDocument,
  EnvironmentExportBundle,
  EnvironmentId,
  EnvironmentInstance,
  EnvironmentInstanceId,
  EnvironmentSnapshot,
  EnvironmentSnapshotId,
  EnvironmentTrashEntry
} from "@infraenv/shared";
import { MAX_PLAYGROUND_LOGICAL_GPUS } from "@infraenv/shared";
import { modelBoot, modelPerformance, parseHardwareGraph } from "@infraenv/simulation";
import type { StorageGateway } from "@infraenv/storage-gateway";

interface RegistryIndex {
  schemaVersion: 1;
  revision: number;
  environments: Record<string, string>;
  snapshots: Record<string, string[]>;
  instances: Record<string, string>;
  checkpoints: Record<string, string[]>;
  trash: Record<string, string>;
}

interface StoredTrashEntry extends EnvironmentTrashEntry {
  checkpointIds: CheckpointId[];
}

export interface EnvironmentRegistryOptions {
  gateway: StorageGateway;
  now?: () => Date;
  idFactory?: () => string;
  trashRetentionDays?: number;
}

export interface ImportEnvironmentOptions { replace?: boolean }
export interface PurgeEnvironmentResult {
  environmentId: EnvironmentId;
  deletedSnapshots: number;
  deletedCheckpoints: number;
  deletedInstances: number;
  workspaceDeleted: false;
  message: string;
}

interface IndexedInstance {
  id: EnvironmentInstanceId;
  key: string;
  value: EnvironmentInstance;
}

export class RegistryError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400, readonly details?: unknown) {
    super(message);
    this.name = "RegistryError";
  }
}

const EMPTY_INDEX: RegistryIndex = {
  schemaVersion: 1,
  revision: 0,
  environments: {},
  snapshots: {},
  instances: {},
  checkpoints: {},
  trash: {}
};

function canonicalJson(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(Object.entries(entry as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]));
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

function checksum(value: unknown): `sha256-${string}` {
  return `sha256-${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function objectKey(kind: "environment" | "snapshot" | "instance" | "checkpoint" | "trash", id: string): string {
  const digest = createHash("sha256").update(id).digest("hex");
  return `${kind}s/${digest}.json`;
}

function assertEnvironment(value: unknown): EnvironmentDocument {
  const result = checkEnvironment(value);
  if (!result.valid) {
    if (result.errors.some((error) => error.keyword === "maximumExpandedAccelerators")) {
      throw new RegistryError("environment_too_large", `Environment may contain at most ${MAX_PLAYGROUND_LOGICAL_GPUS} expanded accelerators.`, 422, result.errors);
    }
    throw new RegistryError("invalid_environment", "Environment document failed schema validation.", 422, result.errors);
  }
  const totalNodes = result.value.spec.nodes.reduce((sum, node) => sum + (node.count ?? 1), 0);
  const totalAccelerators = result.value.spec.nodes.reduce((sum, node) => sum + (node.count ?? 1) * node.accelerators.reduce((count, accelerator) => count + accelerator.count, 0), 0);
  if (totalNodes > 1024) throw new RegistryError("environment_too_large", "Environment may contain at most 1024 expanded nodes.", 422);
  if (totalAccelerators > MAX_PLAYGROUND_LOGICAL_GPUS) throw new RegistryError("environment_too_large", `Environment may contain at most ${MAX_PLAYGROUND_LOGICAL_GPUS} expanded accelerators.`, 422);
  try {
    parseHardwareGraph(result.value);
  } catch (error) {
    throw new RegistryError("invalid_hardware_graph", error instanceof Error ? error.message : String(error), 422);
  }
  return structuredClone(result.value);
}

function snapshotChecksum(snapshot: Omit<EnvironmentSnapshot, "checksum">): `sha256-${string}` {
  return checksum(snapshot);
}

function terminal(instance: EnvironmentInstance): boolean {
  return instance.state === "stopped" || instance.state === "failed";
}

export class EnvironmentRegistry {
  private readonly gateway: StorageGateway;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly trashRetentionDays: number;
  private index?: RegistryIndex;
  private writes: Promise<void> = Promise.resolve();

  constructor(options: EnvironmentRegistryOptions) {
    this.gateway = options.gateway;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.trashRetentionDays = options.trashRetentionDays ?? 30;
  }

  async initialize(): Promise<void> { await this.loadIndex(); }

  private async loadIndex(): Promise<RegistryIndex> {
    if (this.index) return this.index;
    const stored = await this.gateway.getJson<RegistryIndex>("index/registry.json");
    this.index = stored ?? structuredClone(EMPTY_INDEX);
    return this.index;
  }

  private async commit(index: RegistryIndex): Promise<void> {
    index.revision += 1;
    await this.gateway.putJson("index/registry.json", index);
    this.index = index;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation, operation);
    this.writes = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readRequired<T>(key: string, kind: string, id: string): Promise<T> {
    const value = await this.gateway.getJson<T>(key);
    if (!value) throw new RegistryError(`${kind}_not_found`, `${kind} ${id} was not found.`, 404);
    return value;
  }

  async createEnvironment(input: EnvironmentDocument): Promise<EnvironmentDocument> {
    return this.serialize(async () => {
      const document = assertEnvironment(input);
      const index = structuredClone(await this.loadIndex());
      const id = document.metadata.id;
      if (index.environments[id] || index.trash[id]) throw new RegistryError("environment_exists", `Environment ${id} already exists or is in trash.`, 409);
      const key = objectKey("environment", id);
      await this.gateway.putJson(key, document);
      index.environments[id] = key;
      index.snapshots[id] = [];
      index.checkpoints[id] = [];
      await this.commit(index);
      return document;
    });
  }

  async updateEnvironment(environmentId: EnvironmentId, input: EnvironmentDocument, expectedUpdatedAt?: string): Promise<EnvironmentDocument> {
    return this.serialize(async () => {
      const document = assertEnvironment(input);
      if (document.metadata.id !== environmentId) throw new RegistryError("environment_id_mismatch", "Path and document environment IDs differ.", 409);
      const index = structuredClone(await this.loadIndex());
      const key = index.environments[environmentId];
      if (!key) throw new RegistryError("environment_not_found", `Environment ${environmentId} was not found.`, 404);
      const current = await this.readRequired<EnvironmentDocument>(key, "Environment", environmentId);
      if (expectedUpdatedAt && current.metadata.updatedAt !== expectedUpdatedAt) throw new RegistryError("environment_conflict", "Environment has changed since it was read.", 409);
      document.metadata.createdAt = current.metadata.createdAt;
      document.metadata.updatedAt = this.now().toISOString();
      await this.gateway.putJson(key, document);
      await this.commit(index);
      return document;
    });
  }

  async listEnvironments(): Promise<EnvironmentDocument[]> {
    const index = await this.loadIndex();
    const documents = await Promise.all(Object.entries(index.environments).map(([id, key]) => this.readRequired<EnvironmentDocument>(key, "Environment", id)));
    return documents.sort((left, right) => left.metadata.id.localeCompare(right.metadata.id));
  }

  async getEnvironment(environmentId: EnvironmentId): Promise<EnvironmentDocument> {
    const index = await this.loadIndex();
    const key = index.environments[environmentId];
    if (!key) throw new RegistryError("environment_not_found", `Environment ${environmentId} was not found.`, 404);
    return this.readRequired(key, "Environment", environmentId);
  }

  async deleteEnvironment(environmentId: EnvironmentId): Promise<StoredTrashEntry> {
    return this.serialize(async () => {
      const index = structuredClone(await this.loadIndex());
      const key = index.environments[environmentId];
      if (!key) throw new RegistryError("environment_not_found", `Environment ${environmentId} was not found.`, 404);
      const active = (await this.listInstances()).filter((instance) => instance.metadata.environmentId === environmentId && !terminal(instance));
      if (active.length) throw new RegistryError("environment_active", "Stop the active environment instance before deleting it.", 409);
      const document = await this.readRequired<EnvironmentDocument>(key, "Environment", environmentId);
      const deletedAt = this.now();
      const entry: StoredTrashEntry = {
        environmentId,
        deletedAt: deletedAt.toISOString(),
        purgeAfter: new Date(deletedAt.getTime() + this.trashRetentionDays * 86_400_000).toISOString(),
        document,
        snapshotIds: (index.snapshots[environmentId] ?? []) as EnvironmentSnapshotId[],
        checkpointIds: (index.checkpoints[environmentId] ?? []) as CheckpointId[]
      };
      const trashKey = objectKey("trash", environmentId);
      await this.gateway.putJson(trashKey, entry);
      await this.gateway.delete(key);
      delete index.environments[environmentId];
      index.trash[environmentId] = trashKey;
      await this.commit(index);
      return entry;
    });
  }

  async listTrash(): Promise<EnvironmentTrashEntry[]> {
    const index = await this.loadIndex();
    const entries = await Promise.all(Object.entries(index.trash).map(([id, key]) => this.readRequired<StoredTrashEntry>(key, "Trash entry", id)));
    return entries.sort((left, right) => right.deletedAt.localeCompare(left.deletedAt));
  }

  async restoreEnvironment(environmentId: EnvironmentId): Promise<EnvironmentDocument> {
    return this.serialize(async () => {
      const index = structuredClone(await this.loadIndex());
      if (index.environments[environmentId]) throw new RegistryError("environment_exists", `Environment ${environmentId} already exists.`, 409);
      const trashKey = index.trash[environmentId];
      if (!trashKey) throw new RegistryError("trash_not_found", `Environment ${environmentId} is not in trash.`, 404);
      const entry = await this.readRequired<StoredTrashEntry>(trashKey, "Trash entry", environmentId);
      const key = objectKey("environment", environmentId);
      await this.gateway.putJson(key, entry.document);
      await this.gateway.delete(trashKey);
      index.environments[environmentId] = key;
      index.snapshots[environmentId] = [...entry.snapshotIds];
      index.checkpoints[environmentId] = [...entry.checkpointIds];
      delete index.trash[environmentId];
      await this.commit(index);
      return entry.document;
    });
  }

  async purgeEnvironment(environmentId: EnvironmentId): Promise<PurgeEnvironmentResult> {
    return this.serialize(async () => {
      const index = structuredClone(await this.loadIndex());
      const trashKey = index.trash[environmentId];
      if (!trashKey) throw new RegistryError("trash_not_found", `Environment ${environmentId} is not in trash.`, 404);
      const entry = await this.readRequired<StoredTrashEntry>(trashKey, "Trash entry", environmentId);
      const affectedInstances = await this.findAffectedInstances(index, environmentId, entry.snapshotIds);
      const activeInstances = affectedInstances.filter(({ value }) => !terminal(value));
      if (activeInstances.length) {
        throw new RegistryError(
          "environment_active",
          "Stop every active instance that references this environment before purging it.",
          409,
          { instanceIds: activeInstances.map(({ id }) => id) }
        );
      }
      await Promise.all([
        ...entry.snapshotIds.map((id) => this.gateway.delete(objectKey("snapshot", id))),
        ...entry.checkpointIds.map((id) => this.gateway.delete(objectKey("checkpoint", id))),
        ...affectedInstances.map(({ key }) => this.gateway.delete(key)),
        this.gateway.delete(trashKey)
      ]);
      for (const { id } of affectedInstances) delete index.instances[id];
      delete index.trash[environmentId];
      delete index.snapshots[environmentId];
      delete index.checkpoints[environmentId];
      await this.commit(index);
      return {
        environmentId,
        deletedSnapshots: entry.snapshotIds.length,
        deletedCheckpoints: entry.checkpointIds.length,
        deletedInstances: affectedInstances.length,
        workspaceDeleted: false,
        message: "Registry definition, snapshots, checkpoints, and their terminal instance records were purged. External workspace volumes are outside registry ownership and were not deleted."
      };
    });
  }

  async createSnapshot(environmentId: EnvironmentId, label?: string): Promise<EnvironmentSnapshot> {
    return this.serialize(async () => {
      const index = structuredClone(await this.loadIndex());
      const environmentKey = index.environments[environmentId];
      if (!environmentKey) throw new RegistryError("environment_not_found", `Environment ${environmentId} was not found.`, 404);
      const document = await this.readRequired<EnvironmentDocument>(environmentKey, "Environment", environmentId);
      const revisions = index.snapshots[environmentId] ?? [];
      const revision = revisions.reduce((highest, id) => Math.max(highest, Number(/-r(\d+)$/.exec(id)?.[1] ?? 0)), 0) + 1;
      const id = `snapshot:${createHash("sha256").update(environmentId).digest("hex").slice(0, 12)}-r${revision}` as EnvironmentSnapshotId;
      const graph = parseHardwareGraph(document);
      const base: Omit<EnvironmentSnapshot, "checksum"> = {
        apiVersion: "infraenv.io/v1alpha1",
        kind: "EnvironmentSnapshot",
        metadata: { id, environmentId, revision, createdAt: this.now().toISOString(), ...(label ? { label } : {}) },
        document,
        graph,
        boot: modelBoot(document, graph),
        performance: modelPerformance(document, graph)
      };
      const snapshot: EnvironmentSnapshot = { ...base, checksum: snapshotChecksum(base) };
      await this.gateway.putJson(objectKey("snapshot", id), snapshot);
      index.snapshots[environmentId] = [...revisions, id];
      await this.commit(index);
      return snapshot;
    });
  }

  async listSnapshots(environmentId: EnvironmentId): Promise<EnvironmentSnapshot[]> {
    const index = await this.loadIndex();
    const ids = index.snapshots[environmentId];
    if (!ids) throw new RegistryError("environment_not_found", `Environment ${environmentId} was not found.`, 404);
    return Promise.all(ids.map((id) => this.getSnapshot(id as EnvironmentSnapshotId)));
  }

  async getSnapshot(snapshotId: EnvironmentSnapshotId): Promise<EnvironmentSnapshot> {
    return this.readRequired(objectKey("snapshot", snapshotId), "Snapshot", snapshotId);
  }

  async latestSnapshot(environmentId: EnvironmentId): Promise<EnvironmentSnapshot | undefined> {
    const snapshots = await this.listSnapshots(environmentId);
    return snapshots.at(-1);
  }

  async saveInstance(instance: EnvironmentInstance): Promise<void> {
    return this.serialize(async () => {
      const index = structuredClone(await this.loadIndex());
      await this.gateway.putJson(objectKey("instance", instance.metadata.id), instance);
      index.instances[instance.metadata.id] = objectKey("instance", instance.metadata.id);
      await this.commit(index);
    });
  }

  async listInstances(): Promise<EnvironmentInstance[]> {
    const index = await this.loadIndex();
    const instances = await Promise.all(Object.entries(index.instances).map(([id, key]) => this.readRequired<EnvironmentInstance>(key, "Instance", id)));
    return instances.sort((left, right) => right.metadata.createdAt.localeCompare(left.metadata.createdAt));
  }

  async getInstance(instanceId: EnvironmentInstanceId): Promise<EnvironmentInstance> {
    const index = await this.loadIndex();
    const key = index.instances[instanceId];
    if (!key) throw new RegistryError("instance_not_found", `Instance ${instanceId} was not found.`, 404);
    return this.readRequired(key, "Instance", instanceId);
  }

  async createCheckpoint(environmentId: EnvironmentId, options: { instanceId?: EnvironmentInstanceId; label?: string; payload?: Record<string, unknown> } = {}): Promise<EnvironmentCheckpoint> {
    return this.serialize(async () => {
      const index = structuredClone(await this.loadIndex());
      if (!index.environments[environmentId]) throw new RegistryError("environment_not_found", `Environment ${environmentId} was not found.`, 404);
      let instance: EnvironmentInstance | undefined;
      if (options.instanceId) {
        instance = await this.getInstance(options.instanceId);
        if (instance.metadata.environmentId !== environmentId) throw new RegistryError("checkpoint_environment_mismatch", "Instance belongs to another environment.", 409);
      }
      const snapshots = index.snapshots[environmentId] ?? [];
      const snapshotId = instance?.metadata.snapshotId ?? snapshots.at(-1) as EnvironmentSnapshotId | undefined;
      if (!snapshotId) throw new RegistryError("snapshot_required", "Create an environment snapshot before a checkpoint.", 409);
      const payload = structuredClone(options.payload ?? {});
      const virtualTime = typeof payload.virtualTimeSeconds === "number" ? payload.virtualTimeSeconds : 0;
      const checkpointId = `checkpoint:${this.idFactory()}` as CheckpointId;
      const checkpoint: EnvironmentCheckpoint = {
        apiVersion: "infraenv.io/v1alpha1",
        kind: "EnvironmentCheckpoint",
        metadata: {
          id: checkpointId,
          environmentId,
          ...(instance ? { instanceId: instance.metadata.id } : {}),
          createdAt: this.now().toISOString(),
          ...(options.label ? { label: options.label } : {})
        },
        snapshotId,
        activeNodeId: instance?.activeNodeId ?? (await this.getSnapshot(snapshotId)).graph.nodes.find((node) => node.kind === "node")?.id ?? "",
        virtualTimeSeconds: virtualTime,
        payload
      };
      await this.gateway.putJson(objectKey("checkpoint", checkpointId), checkpoint);
      index.checkpoints[environmentId] = [...(index.checkpoints[environmentId] ?? []), checkpointId];
      await this.commit(index);
      return checkpoint;
    });
  }

  async listCheckpoints(environmentId: EnvironmentId): Promise<EnvironmentCheckpoint[]> {
    const index = await this.loadIndex();
    const ids = index.checkpoints[environmentId];
    if (!ids) throw new RegistryError("environment_not_found", `Environment ${environmentId} was not found.`, 404);
    return Promise.all(ids.map((id) => this.getCheckpoint(id as CheckpointId)));
  }

  async getCheckpoint(checkpointId: CheckpointId): Promise<EnvironmentCheckpoint> {
    return this.readRequired(objectKey("checkpoint", checkpointId), "Checkpoint", checkpointId);
  }

  async exportEnvironment(environmentId: EnvironmentId): Promise<EnvironmentExportBundle> {
    const environment = await this.getEnvironment(environmentId);
    const snapshots = await this.listSnapshots(environmentId);
    const checkpoints = await this.listCheckpoints(environmentId);
    const integrity: EnvironmentExportBundle["integrity"] = { environment: checksum(environment) };
    for (const snapshot of snapshots) integrity[`snapshots/${snapshot.metadata.id}`] = checksum(snapshot);
    for (const checkpoint of checkpoints) integrity[`checkpoints/${checkpoint.metadata.id}`] = checksum(checkpoint);
    return { apiVersion: "infraenv.io/export/v1", exportedAt: this.now().toISOString(), environment, snapshots, checkpoints, integrity };
  }

  async importEnvironment(bundle: EnvironmentExportBundle, options: ImportEnvironmentOptions = {}): Promise<EnvironmentDocument> {
    return this.serialize(async () => {
      if (bundle.apiVersion !== "infraenv.io/export/v1") throw new RegistryError("unsupported_export", "Unsupported environment export version.", 422);
      const environment = assertEnvironment(bundle.environment);
      const snapshotIds = new Set<EnvironmentSnapshotId>();
      for (const snapshot of bundle.snapshots) {
        if (snapshotIds.has(snapshot.metadata.id)) {
          throw new RegistryError("duplicate_snapshot_id", `Export bundle contains duplicate snapshot ID ${snapshot.metadata.id}.`, 422);
        }
        snapshotIds.add(snapshot.metadata.id);
      }
      const checkpointIds = new Set<CheckpointId>();
      for (const checkpoint of bundle.checkpoints) {
        if (checkpointIds.has(checkpoint.metadata.id)) {
          throw new RegistryError("duplicate_checkpoint_id", `Export bundle contains duplicate checkpoint ID ${checkpoint.metadata.id}.`, 422);
        }
        checkpointIds.add(checkpoint.metadata.id);
      }
      const expected: EnvironmentExportBundle["integrity"] = { environment: checksum(environment) };
      for (const snapshot of bundle.snapshots) {
        assertEnvironment(snapshot.document);
        const { checksum: recorded, ...base } = snapshot;
        if (recorded !== snapshotChecksum(base)) throw new RegistryError("snapshot_integrity_failed", `Snapshot ${snapshot.metadata.id} checksum is invalid.`, 422);
        if (snapshot.metadata.environmentId !== environment.metadata.id || snapshot.document.metadata.id !== environment.metadata.id) throw new RegistryError("snapshot_environment_mismatch", `Snapshot ${snapshot.metadata.id} belongs to another environment.`, 422);
        expected[`snapshots/${snapshot.metadata.id}`] = checksum(snapshot);
      }
      for (const checkpoint of bundle.checkpoints) {
        if (checkpoint.metadata.environmentId !== environment.metadata.id) throw new RegistryError("checkpoint_environment_mismatch", `Checkpoint ${checkpoint.metadata.id} belongs to another environment.`, 422);
        if (!snapshotIds.has(checkpoint.snapshotId)) {
          throw new RegistryError(
            "checkpoint_snapshot_mismatch",
            `Checkpoint ${checkpoint.metadata.id} references snapshot ${checkpoint.snapshotId}, which is not present in the same environment export bundle.`,
            422
          );
        }
        expected[`checkpoints/${checkpoint.metadata.id}`] = checksum(checkpoint);
      }
      if (canonicalJson(expected) !== canonicalJson(bundle.integrity)) throw new RegistryError("export_integrity_failed", "Export bundle integrity manifest does not match its content.", 422);

      const index = structuredClone(await this.loadIndex());
      const id = environment.metadata.id;
      if ((index.environments[id] || index.trash[id]) && !options.replace) throw new RegistryError("environment_exists", `Environment ${id} already exists or is in trash.`, 409);
      const replacedSnapshotIds = (index.snapshots[id] ?? []) as EnvironmentSnapshotId[];
      const affectedInstances = options.replace ? await this.findAffectedInstances(index, id, replacedSnapshotIds) : [];
      const activeInstances = affectedInstances.filter(({ value }) => !terminal(value));
      if (activeInstances.length) {
        throw new RegistryError(
          "environment_active",
          "Stop the active environment instance before replacing its imported definition.",
          409,
          { instanceIds: activeInstances.map(({ id: instanceId }) => instanceId) }
        );
      }

      for (const snapshot of bundle.snapshots) {
        const owner = Object.entries(index.snapshots).find(([ownerId, ids]) => ownerId !== id && ids.includes(snapshot.metadata.id));
        const stored = await this.gateway.getJson<EnvironmentSnapshot>(objectKey("snapshot", snapshot.metadata.id));
        if (owner || (stored && stored.metadata.environmentId !== id)) {
          throw new RegistryError(
            "snapshot_id_conflict",
            `Snapshot ID ${snapshot.metadata.id} is already owned by another environment.`,
            409,
            { ownerEnvironmentId: owner?.[0] ?? stored?.metadata.environmentId }
          );
        }
      }
      for (const checkpoint of bundle.checkpoints) {
        const owner = Object.entries(index.checkpoints).find(([ownerId, ids]) => ownerId !== id && ids.includes(checkpoint.metadata.id));
        const stored = await this.gateway.getJson<EnvironmentCheckpoint>(objectKey("checkpoint", checkpoint.metadata.id));
        if (owner || (stored && stored.metadata.environmentId !== id)) {
          throw new RegistryError(
            "checkpoint_id_conflict",
            `Checkpoint ID ${checkpoint.metadata.id} is already owned by another environment.`,
            409,
            { ownerEnvironmentId: owner?.[0] ?? stored?.metadata.environmentId }
          );
        }
      }

      // Every schema, integrity, relationship, ownership, and liveness check above is
      // intentionally completed before the first storage mutation below.
      if (options.replace) await this.removeEnvironmentObjects(index, id, affectedInstances);
      const environmentKey = objectKey("environment", id);
      await this.gateway.putJson(environmentKey, environment);
      for (const snapshot of bundle.snapshots) await this.gateway.putJson(objectKey("snapshot", snapshot.metadata.id), snapshot);
      for (const checkpoint of bundle.checkpoints) await this.gateway.putJson(objectKey("checkpoint", checkpoint.metadata.id), checkpoint);
      index.environments[id] = environmentKey;
      index.snapshots[id] = bundle.snapshots.map((snapshot) => snapshot.metadata.id);
      index.checkpoints[id] = bundle.checkpoints.map((checkpoint) => checkpoint.metadata.id);
      delete index.trash[id];
      await this.commit(index);
      return environment;
    });
  }

  private async findAffectedInstances(index: RegistryIndex, environmentId: EnvironmentId, snapshotIds: readonly EnvironmentSnapshotId[]): Promise<IndexedInstance[]> {
    const snapshotIdSet = new Set(snapshotIds);
    const instances = await Promise.all(Object.entries(index.instances).map(async ([rawId, key]) => ({
      id: rawId as EnvironmentInstanceId,
      key,
      value: await this.readRequired<EnvironmentInstance>(key, "Instance", rawId)
    })));
    return instances.filter(({ value }) => value.metadata.environmentId === environmentId || snapshotIdSet.has(value.metadata.snapshotId));
  }

  private async removeEnvironmentObjects(index: RegistryIndex, environmentId: EnvironmentId, instances: readonly IndexedInstance[] = []): Promise<void> {
    const keys: string[] = [];
    const environmentKey = index.environments[environmentId];
    const trashKey = index.trash[environmentId];
    if (environmentKey) keys.push(environmentKey);
    if (trashKey) keys.push(trashKey);
    for (const id of index.snapshots[environmentId] ?? []) keys.push(objectKey("snapshot", id));
    for (const id of index.checkpoints[environmentId] ?? []) keys.push(objectKey("checkpoint", id));
    for (const { key } of instances) keys.push(key);
    await Promise.all(keys.map((key) => this.gateway.delete(key)));
    for (const { id } of instances) delete index.instances[id];
    delete index.environments[environmentId];
    delete index.trash[environmentId];
    delete index.snapshots[environmentId];
    delete index.checkpoints[environmentId];
  }
}

export const registryIntegrity = { canonicalJson, checksum };
