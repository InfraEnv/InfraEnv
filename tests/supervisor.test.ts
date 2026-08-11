import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  EnvironmentDocument,
  EnvironmentExportBundle,
  EnvironmentId,
  EnvironmentInstance,
  EnvironmentInstanceId,
  EnvironmentSnapshotId
} from "@infraenv/shared";
import { environmentFromScenario, findSlowWorkerRuntimeScenario } from "@infraenv/simulation";
import { MemoryS3Backend, StorageGateway } from "@infraenv/storage-gateway";
import {
  EnvironmentInstanceManager,
  EnvironmentRegistry,
  ModelOnlyDriver,
  createSupervisor,
  registryIntegrity,
  startSupervisor
} from "@infraenv/supervisor";

function document(id: EnvironmentId, name = id): EnvironmentDocument {
  const value = environmentFromScenario(findSlowWorkerRuntimeScenario, "2026-08-11T00:00:00.000Z");
  value.metadata.id = id;
  value.metadata.name = name;
  value.spec.nodes = [{ ...value.spec.nodes[0]!, count: 2 }];
  value.spec.fabrics = value.spec.fabrics.map((fabric) => ({ ...fabric, endpointNodeIds: [value.spec.nodes[0]!.id] }));
  return value;
}

async function fixture(maximumActiveInstances = 4) {
  let id = 0;
  const gateway = new StorageGateway(new MemoryS3Backend(), { namespace: "registry", maxObjectBytes: 8 * 1024 * 1024, allowedContentTypes: ["application/json"] });
  const registry = new EnvironmentRegistry({ gateway, trashRetentionDays: 7, idFactory: () => `test-${++id}` });
  await registry.initialize();
  const manager = new EnvironmentInstanceManager({ registry, modelDriver: new ModelOnlyDriver(), dockerDriver: new ModelOnlyDriver(), maximumActiveInstances, idFactory: () => `test-${++id}` });
  return { registry, manager };
}

function refreshBundleIntegrity(bundle: EnvironmentExportBundle): void {
  for (const snapshot of bundle.snapshots) {
    const { checksum: _recorded, ...base } = snapshot;
    void _recorded;
    snapshot.checksum = registryIntegrity.checksum(base);
  }
  bundle.integrity = { environment: registryIntegrity.checksum(bundle.environment) };
  for (const snapshot of bundle.snapshots) bundle.integrity[`snapshots/${snapshot.metadata.id}`] = registryIntegrity.checksum(snapshot);
  for (const checkpoint of bundle.checkpoints) bundle.integrity[`checkpoints/${checkpoint.metadata.id}`] = registryIntegrity.checksum(checkpoint);
}

describe("Environment registry and instance lifecycle", () => {
  it("persists deterministic snapshots, checkpoints, trash, and integrity-protected exports", async () => {
    const { registry, manager } = await fixture();
    const original = await registry.createEnvironment(document("environment:alpha", "Alpha"));
    const first = await registry.createSnapshot(original.metadata.id, "initial");
    const second = await registry.createSnapshot(original.metadata.id, "repeat");
    expect(first.graph).toEqual(second.graph);
    expect(first.boot).toEqual(second.boot);
    expect(first.performance).toEqual(second.performance);
    expect(first.metadata.revision).toBe(1);
    expect(second.metadata.revision).toBe(2);

    const instance = await manager.start(original.metadata.id);
    expect(instance.state).toBe("ready");
    expect(instance.runtime).toMatchObject({ containerIds: [], ptyAvailable: false });
    const execution = await manager.execute(instance.metadata.id, "nvidia-smi -L", instance.activeNodeId);
    expect(execution.result.stdout).toContain("SIMULATED / S2");
    const checkpoint = await manager.createCheckpoint(instance.metadata.id, "healthy-baseline", { virtualTimeSeconds: 12 });
    expect(checkpoint.virtualTimeSeconds).toBe(12);
    const stopped = await manager.stop(instance.metadata.id);
    const failed = structuredClone(stopped);
    failed.metadata.id = "instance:failed-copy" as EnvironmentInstanceId;
    failed.metadata.updatedAt = "2026-08-11T00:01:00.000Z";
    failed.state = "failed";
    failed.error = "Synthetic terminal record for purge coverage.";
    await registry.saveInstance(failed);

    const bundle = await registry.exportEnvironment(original.metadata.id);
    expect(bundle.integrity.environment).toMatch(/^sha256-/);
    const trashed = await registry.deleteEnvironment(original.metadata.id);
    expect(Date.parse(trashed.purgeAfter) - Date.parse(trashed.deletedAt)).toBe(7 * 86_400_000);
    await registry.restoreEnvironment(original.metadata.id);
    expect((await registry.listCheckpoints(original.metadata.id)).map((item) => item.metadata.id)).toContain(checkpoint.metadata.id);
    await registry.deleteEnvironment(original.metadata.id);
    const purged = await registry.purgeEnvironment(original.metadata.id);
    expect(purged).toMatchObject({ deletedSnapshots: 2, deletedCheckpoints: 1, deletedInstances: 2, workspaceDeleted: false });
    expect(await registry.listInstances()).toEqual([]);

    await registry.importEnvironment(bundle);
    expect((await registry.getEnvironment(original.metadata.id)).metadata.name).toBe("Alpha");
    const tampered = structuredClone(bundle);
    tampered.environment.metadata.name = "Tampered";
    await expect(registry.importEnvironment(tampered, { replace: true })).rejects.toMatchObject({ code: "export_integrity_failed" });
  });

  it("preflights replacement liveness, duplicate IDs, checkpoint references, and global object ownership before mutation", async () => {
    const { registry, manager } = await fixture();
    const alphaId = "environment:import-alpha" as EnvironmentId;
    const betaId = "environment:import-beta" as EnvironmentId;
    await registry.createEnvironment(document(alphaId, "Import Alpha"));
    await registry.createEnvironment(document(betaId, "Import Beta"));
    const alphaSnapshot = await registry.createSnapshot(alphaId);
    const betaSnapshot = await registry.createSnapshot(betaId);
    const alphaCheckpoint = await registry.createCheckpoint(alphaId);
    const betaCheckpoint = await registry.createCheckpoint(betaId);
    const betaBundle = await registry.exportEnvironment(betaId);
    const original = structuredClone(betaBundle);

    const assertBetaUnchanged = async () => {
      const current = await registry.exportEnvironment(betaId);
      expect(current.environment).toEqual(original.environment);
      expect(current.snapshots).toEqual(original.snapshots);
      expect(current.checkpoints).toEqual(original.checkpoints);
      expect(current.integrity).toEqual(original.integrity);
    };

    const active = await manager.start(betaId);
    await expect(registry.importEnvironment(structuredClone(betaBundle), { replace: true })).rejects.toMatchObject({ code: "environment_active", statusCode: 409 });
    await assertBetaUnchanged();
    await manager.stop(active.metadata.id);

    const duplicateSnapshot = structuredClone(betaBundle);
    duplicateSnapshot.snapshots.push(structuredClone(duplicateSnapshot.snapshots[0]!));
    await expect(registry.importEnvironment(duplicateSnapshot, { replace: true })).rejects.toMatchObject({ code: "duplicate_snapshot_id", statusCode: 422 });
    await assertBetaUnchanged();

    const duplicateCheckpoint = structuredClone(betaBundle);
    duplicateCheckpoint.checkpoints.push(structuredClone(duplicateCheckpoint.checkpoints[0]!));
    await expect(registry.importEnvironment(duplicateCheckpoint, { replace: true })).rejects.toMatchObject({ code: "duplicate_checkpoint_id", statusCode: 422 });
    await assertBetaUnchanged();

    const missingSnapshot = structuredClone(betaBundle);
    missingSnapshot.checkpoints[0]!.snapshotId = "snapshot:not-in-this-bundle" as EnvironmentSnapshotId;
    refreshBundleIntegrity(missingSnapshot);
    await expect(registry.importEnvironment(missingSnapshot, { replace: true })).rejects.toMatchObject({ code: "checkpoint_snapshot_mismatch", statusCode: 422 });
    await assertBetaUnchanged();

    const snapshotConflict = structuredClone(betaBundle);
    snapshotConflict.snapshots[0]!.metadata.id = alphaSnapshot.metadata.id;
    snapshotConflict.checkpoints[0]!.snapshotId = alphaSnapshot.metadata.id;
    refreshBundleIntegrity(snapshotConflict);
    await expect(registry.importEnvironment(snapshotConflict, { replace: true })).rejects.toMatchObject({
      code: "snapshot_id_conflict",
      statusCode: 409,
      details: { ownerEnvironmentId: alphaId }
    });
    await assertBetaUnchanged();

    const checkpointConflict = structuredClone(betaBundle);
    checkpointConflict.checkpoints[0]!.metadata.id = alphaCheckpoint.metadata.id;
    refreshBundleIntegrity(checkpointConflict);
    await expect(registry.importEnvironment(checkpointConflict, { replace: true })).rejects.toMatchObject({
      code: "checkpoint_id_conflict",
      statusCode: 409,
      details: { ownerEnvironmentId: alphaId }
    });
    await assertBetaUnchanged();

    expect(betaSnapshot.metadata.environmentId).toBe(betaId);
    expect(betaCheckpoint.metadata.environmentId).toBe(betaId);
    await registry.importEnvironment(structuredClone(betaBundle), { replace: true });
    expect((await registry.listInstances()).filter((item) => item.metadata.environmentId === betaId)).toEqual([]);
  });

  it("enforces one active instance per environment and a global maximum of four", async () => {
    const { registry, manager } = await fixture(4);
    for (let index = 0; index < 5; index += 1) {
      const id = `environment:e${index}` as EnvironmentId;
      await registry.createEnvironment(document(id));
      await registry.createSnapshot(id);
    }
    const first = await manager.start("environment:e0");
    await expect(manager.start("environment:e0")).rejects.toMatchObject({ code: "environment_already_active" });
    await manager.start("environment:e1");
    await manager.start("environment:e2");
    await manager.start("environment:e3");
    await expect(manager.start("environment:e4")).rejects.toMatchObject({ code: "instance_limit", statusCode: 429 });
    await manager.stop(first.metadata.id);
    expect((await manager.start("environment:e4")).state).toBe("ready");
  });

  it("enforces the shared 4096 logical-GPU boundary and rejects generic Docker mode", async () => {
    const { registry, manager } = await fixture();
    const atLimit = document("environment:gpu-limit");
    atLimit.spec.nodes = [{ ...atLimit.spec.nodes[0]!, count: 256, accelerators: [{ ...atLimit.spec.nodes[0]!.accelerators[0]!, count: 16 }] }];
    await expect(registry.createEnvironment(atLimit)).resolves.toMatchObject({ metadata: { id: "environment:gpu-limit" } });

    const aboveLimit = structuredClone(atLimit);
    aboveLimit.metadata.id = "environment:gpu-over-limit";
    aboveLimit.spec.nodes.push({
      ...structuredClone(atLimit.spec.nodes[0]!),
      id: "one-extra-node",
      count: 1,
      accelerators: [{ ...structuredClone(atLimit.spec.nodes[0]!.accelerators[0]!), count: 1 }]
    });
    await expect(registry.createEnvironment(aboveLimit)).rejects.toMatchObject({ code: "environment_too_large", statusCode: 422 });
    await expect(manager.start("environment:gpu-limit", { docker: true })).rejects.toMatchObject({
      code: "capability_unavailable",
      statusCode: 501,
      details: { capability: "environment.docker-start", status: "unavailable" }
    });
  });
});

describe("Supervisor API security and dual DTOs", () => {
  it("supports canonical raw CLI resources, Web UI projections, and one-time browser launch", async () => {
    const { registry, manager } = await fixture();
    const uiDirectory = await mkdtemp(join(tmpdir(), "infraenv-ui-"));
    await writeFile(join(uiDirectory, "index.html"), "<!doctype html><title>InfraEnv test UI</title>", "utf8");
    const app = createSupervisor({ registry, instances: manager, token: "host-test-token", webUiDirectory: uiDirectory, webUiBaseUrl: "http://127.0.0.1:7331/app/" });
    const auth = { authorization: "Bearer host-test-token" };
    try {
      expect((await app.inject({ method: "GET", url: "/api/v1/environments" })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/api/v1/health" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/app/" })).statusCode).toBe(200);

      const presets = await app.inject({ method: "GET", url: "/api/v1/presets", headers: auth });
      expect(presets.statusCode).toBe(200);
      const presetItems = presets.json<{ items: Array<{ id: string; version: string; resources: { racks: number; nodes: number; accelerators: number }; suggestedDraft?: { inventory: { rackCount: number; nodesPerRack: number; acceleratorsPerNode: number } } }> }>().items;
      expect(presetItems.length).toBeGreaterThan(10);
      const eightRack = presetItems.find((item) => item.id === "preset:gb200-superpod-eight-rack");
      expect(eightRack).toMatchObject({
        resources: { racks: 8, nodes: 144, accelerators: 576 },
        suggestedDraft: { inventory: { rackCount: 8, nodesPerRack: 18, acceleratorsPerNode: 4 } }
      });
      const exactPreset = await app.inject({ method: "GET", url: `/api/v1/presets/${encodeURIComponent(`${eightRack!.id}@${eightRack!.version}`)}`, headers: auth });
      expect(exactPreset.statusCode).toBe(200);
      expect(exactPreset.json()).toMatchObject({ id: eightRack!.id, version: eightRack!.version, fidelity: "exact", systemGroups: [{ count: 8 }] });

      const derivedFromRackPreset = await app.inject({
        method: "POST",
        url: "/api/v1/environments",
        headers: auth,
        payload: { name: "derived-gb200", source: { kind: "template", templateId: eightRack!.id, version: eightRack!.version } }
      });
      expect(derivedFromRackPreset.statusCode).toBe(200);
      const derivedEnvironmentId = derivedFromRackPreset.json<{ id: EnvironmentId }>().id;
      const derivedDocument = await app.inject({ method: "GET", url: `/api/v1/environments/${derivedEnvironmentId}?raw=true`, headers: auth });
      expect(derivedDocument.json<EnvironmentDocument>()).toMatchObject({
        metadata: { labels: { "infraenv.dev/derived-from-preset": "preset:gb200-superpod-eight-rack@1.0.0" } },
        spec: { placement: { rackCount: 8, nodesPerRack: 18 }, nodes: [{ count: 144, accelerators: [{ count: 4 }] }] }
      });

      const created = await app.inject({
        method: "POST",
        url: "/api/v1/environments",
        headers: auth,
        payload: {
          name: "api-demo",
          seed: 42,
          source: { kind: "playground" },
          inventory: { rackCount: 1, nodesPerRack: 2, acceleratorsPerNode: 2, acceleratorModel: "CUSTOM / UNVERIFIED accelerator" },
          topology: { intraNode: "pcie", nvlinkGeneration: "none", interNode: "ethernet", interRack: "fat-tree" },
          workspace: { persistent: false },
          objectStorage: { mode: "disabled" }
        }
      });
      expect(created.statusCode).toBe(200);
      const environmentId = created.json<{ id: EnvironmentId }>().id;
      expect(environmentId).toMatch(/^environment:/);

      const started = await app.inject({ method: "POST", url: `/api/v1/environments/${environmentId}/start?raw=true`, headers: auth, payload: {} });
      expect(started.statusCode).toBe(200);
      const instance = started.json<EnvironmentInstance>();
      expect(instance.kind).toBe("EnvironmentInstance");
      const command = await app.inject({ method: "POST", url: `/api/v1/instances/${instance.metadata.id}/execute?raw=true`, headers: auth, payload: { command: "infraenv bench p2p" } });
      expect(command.json<{ stdout: string }>().stdout).toContain("p2p.theory=");

      const projected = await app.inject({ method: "GET", url: `/api/v1/instances/${instance.metadata.id}`, headers: auth });
      const detail = projected.json<{ topology: Array<{ children: Array<{ children: Array<{ children: Array<{ count: number }> }> }> }>; capabilities: string[] }>();
      expect(detail.topology[0]!.children[0]!.children[0]!.children[0]!.count).toBe(2);
      expect(detail.capabilities).not.toContain("terminal.attach");

      const launch = await app.inject({ method: "POST", url: "/api/v1/auth/webui-launch", headers: auth, payload: {} });
      const launchUrl = new URL(launch.json<{ url: string }>().url);
      const launchToken = new URLSearchParams(launchUrl.hash.slice(1)).get("launchToken")!;
      const exchange = await app.inject({ method: "POST", url: "/api/v1/auth/exchange", headers: { origin: launchUrl.origin }, payload: { launchToken } });
      expect(exchange.statusCode).toBe(200);
      expect(exchange.headers["set-cookie"]).toContain("HttpOnly");
      expect(exchange.headers["set-cookie"]).toContain("SameSite=Strict");
      const replay = await app.inject({ method: "POST", url: "/api/v1/auth/exchange", headers: { origin: launchUrl.origin }, payload: { launchToken } });
      expect(replay.statusCode).toBe(401);
      const cookie = String(exchange.headers["set-cookie"]).split(";")[0]!;
      const status = await app.inject({ method: "GET", url: "/api/v1/status" });
      const csrfToken = status.json<{ csrfToken: string }>().csrfToken;
      const browserPayload = { name: "browser-demo", inventory: { rackCount: 1, nodesPerRack: 1, acceleratorsPerNode: 1 } };
      expect((await app.inject({ method: "POST", url: "/api/v1/environments", headers: { cookie, host: launchUrl.host, origin: "http://evil.example", "x-infraenv-csrf": csrfToken }, payload: browserPayload })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/api/v1/environments", headers: { cookie, host: launchUrl.host, origin: launchUrl.origin }, payload: browserPayload })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/api/v1/environments", headers: { cookie, host: launchUrl.host, origin: launchUrl.origin, "x-infraenv-csrf": csrfToken }, payload: browserPayload })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: `/api/v1/environments?token=host-test-token` })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("reports purged terminal instance records through the API and leaves no dangling snapshot reference", async () => {
    const { registry, manager } = await fixture();
    const environmentId = "environment:api-purge" as EnvironmentId;
    await registry.createEnvironment(document(environmentId, "API Purge"));
    await registry.createSnapshot(environmentId);
    const instance = await manager.start(environmentId);
    await manager.stop(instance.metadata.id);
    const app = createSupervisor({ registry, instances: manager, token: "host-test-token" });
    const auth = { authorization: "Bearer host-test-token" };
    try {
      expect((await app.inject({ method: "DELETE", url: `/api/v1/environments/${environmentId}`, headers: auth })).statusCode).toBe(204);
      const purge = await app.inject({ method: "DELETE", url: `/api/v1/environments/${environmentId}/purge`, headers: auth });
      expect(purge.statusCode).toBe(200);
      expect(purge.json()).toMatchObject({ environmentId, deletedSnapshots: 1, deletedCheckpoints: 0, deletedInstances: 1, workspaceDeleted: false });
      expect(await registry.listInstances()).toEqual([]);
      await expect(registry.getInstance(instance.metadata.id)).rejects.toMatchObject({ code: "instance_not_found", statusCode: 404 });
    } finally {
      await app.close();
    }
  });

  it("accepts 4096 compact logical GPUs and rejects larger products before graph expansion", async () => {
    const { registry, manager } = await fixture();
    const app = createSupervisor({ registry, instances: manager, token: "host-test-token" });
    try {
      const auth = { authorization: "Bearer host-test-token" };
      const accepted = await app.inject({ method: "POST", url: "/api/v1/environments", headers: auth, payload: { name: "at-limit", inventory: { rackCount: 32, nodesPerRack: 8, acceleratorsPerNode: 16 } } });
      expect(accepted.statusCode).toBe(200);
      const rejected = await app.inject({ method: "POST", url: "/api/v1/environments", headers: auth, payload: { name: "over-limit", inventory: { rackCount: 33, nodesPerRack: 8, acceleratorsPerNode: 16 } } });
      expect(rejected.statusCode).toBe(422);
      expect((await registry.listEnvironments()).map((item) => item.metadata.name)).toEqual(["at-limit"]);

      const environmentId = accepted.json<{ id: EnvironmentId }>().id;
      const dockerStart = await app.inject({ method: "POST", url: `/api/v1/instances?raw=true`, headers: auth, payload: { environmentId, docker: true } });
      expect(dockerStart.statusCode).toBe(501);
      expect(dockerStart.json()).toMatchObject({ error: "capability_unavailable", details: { capability: "environment.docker-start", status: "unavailable" } });
    } finally { await app.close(); }
  });

  it("refuses a non-loopback Supervisor bind at the lowest-level entry point", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "infraenv-bind-"));
    await expect(startSupervisor({ host: "0.0.0.0", port: 0, dataDirectory, token: "test-token", reconcilePersistedInstances: false })).rejects.toMatchObject({ code: "non_loopback_bind" });
  });
});
