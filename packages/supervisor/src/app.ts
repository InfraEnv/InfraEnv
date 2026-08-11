import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type {
  CheckpointId,
  EnvironmentDocument,
  EnvironmentExportBundle,
  EnvironmentId,
  EnvironmentInstance,
  EnvironmentInstanceId,
  EnvironmentSnapshot,
  EnvironmentSnapshotId
} from "@infraenv/shared";
import { MAX_PLAYGROUND_LOGICAL_GPUS, RUNTIME_VERSION } from "@infraenv/shared";
import { parseHardwareGraph, runtimeCurriculumProfile } from "@infraenv/simulation";
import { LocalFilesystemBackend, StorageGateway } from "@infraenv/storage-gateway";
import { DockerContainerDriver, ModelOnlyDriver, RuntimeDriverError, type RuntimeDriverCapabilities } from "./drivers.js";
import { EnvironmentInstanceManager, InstanceManagerError } from "./instance-manager.js";
import { EnvironmentRegistry, RegistryError } from "./registry.js";

const API_PREFIX = "/api/v1";
const SUPPORTED_CAPABILITIES = [
  "environment.create", "environment.start", "environment.stop", "environment.update", "environment.clone",
  "environment.export", "environment.import", "environment.trash", "checkpoint.create", "checkpoint.restore",
  "control.pause", "control.resume", "control.reset", "control.restart", "definition.reconcile", "node.execute"
] as const;

const UNAVAILABLE_CAPABILITIES = {
  "environment.docker-start": "Generic Docker Playground instances are unavailable in v0.2: the current driver starts only one Sandbox and does not provision the required Runtime Sidecar or persistent workspace volume. Course-v1 Docker labs use a separate complete lifecycle.",
  "terminal.attach": "A browser PTY broker is not implemented. DockerDriver only exposes caller-owned docker exec arguments.",
  "storage.connect": "External storage credentials and network access are not implemented.",
  "storage.symbolic-load": "Symbolic object-to-HBM placement events are not implemented.",
  "fault.inject": "Generic Environment fault injection is not implemented; course-v1 faults remain in the course Runtime."
} as const;

interface EnvironmentDraft {
  id?: string;
  name: string;
  description?: string;
  seed?: number;
  source?: { kind?: string; templateId?: string; version?: string };
  inventory?: { rackCount?: number; nodesPerRack?: number; acceleratorsPerNode?: number; acceleratorModel?: string };
  topology?: { intraNode?: string; nvlinkGeneration?: string; interNode?: string; interRack?: string };
  workspace?: { persistent?: boolean };
  objectStorage?: { mode?: string; connectorId?: string };
  revision?: number;
}

function curriculumCollection(name: string): Array<Record<string, unknown>> {
  const value = (runtimeCurriculumProfile as unknown as Record<string, unknown>)[name];
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [];
}

function resolvePreset(idOrSlug: string, version?: string): Record<string, unknown> {
  const explicit = idOrSlug.includes("@") ? idOrSlug.split("@", 2) : undefined;
  const id = explicit?.[0] ?? idOrSlug;
  const wantedVersion = explicit?.[1] ?? version;
  const matches = curriculumCollection("presets").filter((preset) => (preset.id === id || preset.slug === id) && (!wantedVersion || preset.version === wantedVersion));
  if (!matches.length) throw new RegistryError("preset_not_found", `Curriculum preset ${idOrSlug}${version ? `@${version}` : ""} was not found.`, 422);
  if (matches.length > 1) throw new RegistryError("preset_ambiguous", `Preset alias ${idOrSlug} matches multiple versions; use id@version.`, 409);
  return matches[0] as Record<string, unknown>;
}

interface CompactPresetProfile {
  rackCount: number;
  nodesPerRack: number;
  nodeCount: number;
  acceleratorCount: number;
  acceleratorsPerNode: number;
  acceleratorModel?: string;
  intraNode: "pcie" | "nvlink" | "nvswitch";
  nvlinkGeneration: string;
  interNode: "ethernet" | "infiniband";
  interRack: "fat-tree" | "rail-optimized" | "dragonfly";
  fabric?: string;
  builderCompatible: boolean;
  limitation?: string;
}

function versionedEntity(collection: Array<Record<string, unknown>>, reference: unknown): Record<string, unknown> | undefined {
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) return undefined;
  const value = reference as { id?: unknown; version?: unknown };
  return collection.find((item) => item.id === value.id && item.version === value.version);
}

/**
 * Projects a curriculum Preset into the deliberately homogeneous Builder DTO.
 * It preserves rack-form systems as racks containing compute units; it never
 * treats an NVL72 rack as one 72-GPU node.
 */
function compactPresetProfile(preset: Record<string, unknown>): CompactPresetProfile {
  const systems = curriculumCollection("systems");
  const accelerators = curriculumCollection("accelerators");
  const fabrics = curriculumCollection("fabrics");
  const groups = Array.isArray(preset.systemGroups) ? preset.systemGroups as Array<Record<string, unknown>> : [];
  const resolved = groups.flatMap((group) => {
    const system = versionedEntity(systems, group.systemRef);
    const structure = system?.structure && typeof system.structure === "object" && !Array.isArray(system.structure) ? system.structure as Record<string, unknown> : undefined;
    const count = Number(group.count ?? 0);
    const computeUnits = Number(structure?.computeUnitCount ?? 0);
    const acceleratorsPerComputeUnit = Number(structure?.acceleratorsPerComputeUnit ?? 0);
    const accelerator = versionedEntity(accelerators, system?.acceleratorRef);
    if (!system || !structure || !Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(computeUnits) || computeUnits < 1 || !Number.isSafeInteger(acceleratorsPerComputeUnit) || acceleratorsPerComputeUnit < 0) return [];
    return [{ group, system, structure, count, computeUnits, acceleratorsPerComputeUnit, accelerator }];
  });
  if (resolved.length !== groups.length || resolved.length === 0) {
    return { rackCount: 1, nodesPerRack: 1, nodeCount: 1, acceleratorCount: 0, acceleratorsPerNode: 0, intraNode: "pcie", nvlinkGeneration: "custom-modeled", interNode: "infiniband", interRack: "fat-tree", builderCompatible: false, limitation: "Preset hierarchy could not be resolved to exact versioned systems." };
  }

  const rackForm = resolved.every((row) => row.system.formFactor === "rack");
  const rackCount = rackForm ? resolved.reduce((sum, row) => sum + row.count, 0) : 1;
  const nodeCount = resolved.reduce((sum, row) => sum + row.count * row.computeUnits, 0);
  const acceleratorCount = resolved.reduce((sum, row) => sum + row.count * row.computeUnits * row.acceleratorsPerComputeUnit, 0);
  const acceleratorsPerNodeValues = new Set(resolved.map((row) => row.acceleratorsPerComputeUnit));
  const acceleratorModels = new Set(resolved.map((row) => typeof row.accelerator?.model === "string" ? row.accelerator.model : undefined).filter((value): value is string => Boolean(value)));
  const topologies = new Set(resolved.map((row) => String(row.structure.intraSystemTopology ?? "pcie-only")));
  const firstSystemFabricRefs = Array.isArray(resolved[0]?.system.intraSystemFabricRefs) ? resolved[0].system.intraSystemFabricRefs as unknown[] : [];
  const nvlinkFabric = firstSystemFabricRefs.map((reference) => versionedEntity(fabrics, reference)).find((fabric) => fabric?.technology === "nvlink");
  const presetFabric = Array.isArray(preset.fabrics) ? (preset.fabrics as Array<Record<string, unknown>>)[0] : undefined;
  const scaleOutFabric = versionedEntity(fabrics, presetFabric?.fabricRef);
  const topology = String(presetFabric?.topology ?? "fat-tree");
  const interRack = topology === "rail-optimized" || topology === "dragonfly" ? topology : "fat-tree";
  const intraTopology = topologies.size === 1 ? [...topologies][0] : "heterogeneous";
  const intraNode = intraTopology === "nvswitch" ? "nvswitch" : intraTopology === "pcie-only" ? "pcie" : "nvlink";
  const acceleratorsPerNode = acceleratorsPerNodeValues.size === 1 ? [...acceleratorsPerNodeValues][0]! : Math.ceil(acceleratorCount / Math.max(1, nodeCount));
  const nodesPerRack = Math.ceil(nodeCount / Math.max(1, rackCount));
  const builderCompatible = resolved.length === groups.length
    && acceleratorsPerNodeValues.size === 1
    && acceleratorModels.size <= 1
    && topologies.size === 1
    && rackCount <= 128
    && nodesPerRack <= 128
    && nodeCount <= 1024
    && acceleratorsPerNode <= 16
    && acceleratorCount <= MAX_PLAYGROUND_LOGICAL_GPUS;
  return {
    rackCount,
    nodesPerRack,
    nodeCount,
    acceleratorCount,
    acceleratorsPerNode,
    ...([...acceleratorModels][0] ? { acceleratorModel: [...acceleratorModels][0] } : {}),
    intraNode,
    nvlinkGeneration: typeof nvlinkFabric?.generation === "string" ? nvlinkFabric.generation : "custom-modeled",
    interNode: scaleOutFabric?.technology === "ethernet" ? "ethernet" : "infiniband",
    interRack,
    ...(typeof scaleOutFabric?.technology === "string" ? { fabric: scaleOutFabric.technology } : {}),
    builderCompatible,
    ...(!builderCompatible ? { limitation: "Preset is heterogeneous or exceeds the homogeneous Builder safety boundary; inspect it read-only instead." } : {})
  };
}

function presetSummaries() {
  return curriculumCollection("presets").map((preset) => {
    const compact = compactPresetProfile(preset);
    return {
      id: String(preset.id),
      version: String(preset.version),
      name: String(preset.title ?? preset.id),
      ...(typeof preset.disclosure === "string" ? { description: preset.disclosure } : {}),
      category: compact.rackCount > 1 || compact.nodeCount > 1 ? "cluster" : "node",
      fidelity: String(preset.fidelity ?? "freeform"),
      builderCompatible: compact.builderCompatible,
      ...(compact.limitation ? { limitation: compact.limitation } : {}),
      suggestedDraft: {
        inventory: { rackCount: compact.rackCount, nodesPerRack: compact.nodesPerRack, acceleratorsPerNode: compact.acceleratorsPerNode, ...(compact.acceleratorModel ? { acceleratorModel: compact.acceleratorModel } : {}) },
        topology: { intraNode: compact.intraNode, nvlinkGeneration: compact.nvlinkGeneration, interNode: compact.interNode, interRack: compact.interRack }
      },
      resources: {
        racks: compact.rackCount,
        nodes: compact.nodeCount,
        accelerators: compact.acceleratorCount,
        ...(compact.acceleratorModel ? { acceleratorModel: compact.acceleratorModel } : {}),
        ...(compact.fabric ? { fabric: compact.fabric } : {})
      }
    };
  });
}

export interface CreateSupervisorOptions {
  registry: EnvironmentRegistry;
  instances?: EnvironmentInstanceManager;
  token?: string;
  webUiBaseUrl?: string;
  webUiDirectory?: string;
  logger?: boolean;
}

export interface LocalSupervisorOptions {
  dataDirectory?: string;
  token?: string;
  webUiBaseUrl?: string;
  webUiDirectory?: string;
  logger?: boolean;
  maximumActiveInstances?: number;
  dockerImage?: string;
  reconcilePersistedInstances?: boolean;
}

export interface StartSupervisorOptions extends LocalSupervisorOptions {
  host?: string;
  port?: number;
}

export interface SupervisorContext {
  token: string;
  csrfToken: string;
  sessionToken: string;
  registry: EnvironmentRegistry;
  instances: EnvironmentInstanceManager;
  webUiAvailable: boolean;
  issueWebUiLaunch(baseUrl?: string): { url: string; expiresAt: string };
  setWebUiBaseUrl(baseUrl: string): void;
}

export interface SupervisorApp extends FastifyInstance { supervisor: SupervisorContext }

export interface RunningSupervisor extends SupervisorContext {
  app: SupervisorApp;
  address: string;
  close(): Promise<void>;
}

function fixedEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function bearer(request: FastifyRequest): string | undefined {
  const value = request.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice(7) : undefined;
}

function cookies(request: FastifyRequest): Record<string, string> {
  return Object.fromEntries((request.headers.cookie ?? "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const split = part.indexOf("=");
    return split < 0 ? [part, ""] : [part.slice(0, split), decodeURIComponent(part.slice(split + 1))];
  }));
}

function isPublic(request: FastifyRequest): boolean {
  const path = request.url.split("?")[0];
  return path === "/app" || Boolean(path?.startsWith("/app/")) || path === `${API_PREFIX}/health` || path === `${API_PREFIX}/status` || path === `${API_PREFIX}/capabilities` || path === `${API_PREFIX}/auth/exchange`;
}

function slug(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "environment";
}

function isEnvironmentDocument(value: unknown): value is EnvironmentDocument {
  return Boolean(value && typeof value === "object" && (value as { kind?: unknown }).kind === "Environment");
}

function validateDraft(draft: EnvironmentDraft): void {
  if (typeof draft.name !== "string" || draft.name.trim().length < 1 || draft.name.length > 120) throw new RegistryError("invalid_environment_name", "Environment name must contain 1 to 120 characters.", 422);
  if (draft.description !== undefined && (typeof draft.description !== "string" || draft.description.length > 1000)) throw new RegistryError("invalid_environment_description", "Environment description may contain at most 1000 characters.", 422);
  const seed = draft.seed ?? 240_803;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) throw new RegistryError("invalid_environment_seed", "Environment seed must be a uint32 integer.", 422);
  const racks = draft.inventory?.rackCount ?? 1;
  const nodesPerRack = draft.inventory?.nodesPerRack ?? 1;
  const acceleratorsPerNode = draft.inventory?.acceleratorsPerNode ?? 8;
  if (!Number.isInteger(racks) || racks < 1 || racks > 128) throw new RegistryError("invalid_rack_count", "rackCount must be an integer from 1 to 128.", 422);
  if (!Number.isInteger(nodesPerRack) || nodesPerRack < 1 || nodesPerRack > 128) throw new RegistryError("invalid_node_count", "nodesPerRack must be an integer from 1 to 128.", 422);
  if (!Number.isInteger(acceleratorsPerNode) || acceleratorsPerNode < 0 || acceleratorsPerNode > 16) throw new RegistryError("invalid_accelerator_count", "acceleratorsPerNode must be an integer from 0 to 16.", 422);
  if (racks * nodesPerRack > 1024 || racks * nodesPerRack * acceleratorsPerNode > MAX_PLAYGROUND_LOGICAL_GPUS) throw new RegistryError("environment_too_large", `Expanded Environment exceeds the 1024-node or ${MAX_PLAYGROUND_LOGICAL_GPUS}-accelerator safety limit.`, 422);
  if (draft.inventory?.acceleratorModel !== undefined && (typeof draft.inventory.acceleratorModel !== "string" || draft.inventory.acceleratorModel.length > 160)) throw new RegistryError("invalid_accelerator_model", "Accelerator model must be a string of at most 160 characters.", 422);
}

function draftToDocument(draft: EnvironmentDraft, environmentId?: EnvironmentId, current?: EnvironmentDocument): EnvironmentDocument {
  const preset = draft.source?.templateId ? resolvePreset(draft.source.templateId, draft.source.version) : undefined;
  const presetDefaults = preset ? compactPresetProfile(preset) : undefined;
  if (presetDefaults && !presetDefaults.builderCompatible) throw new RegistryError("preset_not_builder_compatible", presetDefaults.limitation ?? "Preset cannot be represented by the homogeneous Builder.", 422);
  const resolvedDraft: EnvironmentDraft = {
    ...draft,
    inventory: {
      ...(presetDefaults ? { rackCount: presetDefaults.rackCount, nodesPerRack: presetDefaults.nodesPerRack, acceleratorsPerNode: presetDefaults.acceleratorsPerNode, ...(presetDefaults.acceleratorModel ? { acceleratorModel: presetDefaults.acceleratorModel } : {}) } : {}),
      ...draft.inventory
    },
    topology: {
      ...(presetDefaults ? { intraNode: presetDefaults.intraNode, nvlinkGeneration: presetDefaults.nvlinkGeneration, interNode: presetDefaults.interNode, interRack: presetDefaults.interRack } : {}),
      ...draft.topology
    }
  };
  validateDraft(resolvedDraft);
  const now = new Date().toISOString();
  const racks = Math.max(1, Math.trunc(resolvedDraft.inventory?.rackCount ?? 1));
  const nodesPerRack = Math.max(1, Math.trunc(resolvedDraft.inventory?.nodesPerRack ?? 1));
  const acceleratorsPerNode = Math.max(0, Math.trunc(resolvedDraft.inventory?.acceleratorsPerNode ?? 8));
  const acceleratorModel = resolvedDraft.inventory?.acceleratorModel ?? "NVIDIA H100 SXM (SIMULATED)";
  const intraNode = resolvedDraft.topology?.intraNode ?? "nvswitch";
  const interNode = resolvedDraft.topology?.interNode === "ethernet" ? "ethernet" : "infiniband";
  const requestedInterRack = resolvedDraft.topology?.interRack;
  const interRackTopology = requestedInterRack === "ring" || requestedInterRack === "mesh" || requestedInterRack === "fully-connected" || requestedInterRack === "rail-optimized" || requestedInterRack === "dragonfly"
    ? requestedInterRack
    : "fat-tree";
  const id = environmentId ?? `environment:${slug(resolvedDraft.id ?? resolvedDraft.name)}-${randomUUID().slice(0, 6)}` as EnvironmentId;
  const derivedPreset = preset ? `${String(preset.id)}@${String(preset.version)}` : undefined;
  const acceleratorFidelity = preset ? "derived-from-catalog" : "custom-unverified";
  const labels = {
    ...(current?.metadata.labels ?? {}),
    "infraenv.dev/rack-count": String(racks),
    "infraenv.dev/nodes-per-rack": String(nodesPerRack),
    "infraenv.dev/mode": "playground",
    "infraenv.dev/accelerator-fidelity": acceleratorFidelity,
    "infraenv.dev/topology-fidelity": "custom-modeled",
    "infraenv.dev/workspace-persistent-requested": String(Boolean(resolvedDraft.workspace?.persistent)),
    ...(resolvedDraft.workspace?.persistent ? { "infraenv.dev/workspace-status": "planned-unavailable" } : {}),
    ...(derivedPreset ? { "infraenv.dev/derived-from-preset": derivedPreset, "infraenv.dev/source-fidelity": "derived-freeform" } : {})
  };
  const nodeTemplate = "compute-node";
  return {
    apiVersion: "infraenv.io/v1alpha1",
    kind: "Environment",
    metadata: {
      id,
      name: resolvedDraft.name,
      ...(resolvedDraft.description ? { description: resolvedDraft.description } : {}),
      createdAt: current?.metadata.createdAt ?? now,
      updatedAt: now,
      labels
    },
    spec: {
      simulationLevel: "S2",
      seed: Math.max(0, Math.trunc(resolvedDraft.seed ?? 240_803)),
      placement: { rackCount: racks, nodesPerRack },
      nodes: [{
        id: nodeTemplate,
        count: racks * nodesPerRack,
        roles: ["compute"],
        cpuCores: 96,
        memoryGiB: 1024,
        labels: { "infraenv.dev/accelerator-values": "heuristic-s2-not-catalog-resolved" },
        accelerators: acceleratorsPerNode ? [{
          id: "gpu",
          acceleratorRef: { id: `accelerator:${slug(acceleratorModel.replace(/\(simulated\)/i, ""))}`, version: "1.0.0" },
          count: acceleratorsPerNode,
          memoryGiB: /h100/i.test(acceleratorModel) ? 80 : 48,
          peakTflops: /h100/i.test(acceleratorModel) ? 989 : 312,
          interconnect: intraNode === "pcie" ? "pcie" : "nvlink",
          interconnectTopology: intraNode === "pcie" ? "pcie-only" : intraNode === "nvswitch" ? "switch" : "direct",
          ...(intraNode === "pcie" ? {} : { interconnectGeneration: resolvedDraft.topology?.nvlinkGeneration || "custom-modeled" }),
          ...(intraNode === "nvswitch" ? { interconnectSwitchCount: 1 } : {}),
          interconnectBandwidthGBps: intraNode === "pcie" ? 64 : /h100/i.test(acceleratorModel) ? 450 : 100
        }] : []
      }],
      fabrics: [{
        id: "cluster-fabric",
        kind: interNode,
        topology: interRackTopology,
        bandwidthGbps: interNode === "infiniband" ? 400 : 100,
        latencyMicroseconds: interNode === "infiniband" ? 2.5 : 12,
        endpointNodeIds: [nodeTemplate],
        oversubscriptionRatio: 1
      }],
      storage: resolvedDraft.objectStorage?.mode && resolvedDraft.objectStorage.mode !== "disabled" ? [{
        id: "object-storage",
        kind: "object",
        capacityGiB: 102_400,
        readBandwidthGbps: 25,
        writeBandwidthGbps: 12.5,
        endpointNodeIds: [nodeTemplate]
      }] : []
    }
  };
}

function documentToDraft(document: EnvironmentDocument, revision: number): EnvironmentDraft {
  const node = document.spec.nodes[0];
  const accelerator = node?.accelerators[0];
  const fabric = document.spec.fabrics[0];
  const racks = Number(document.spec.placement?.rackCount ?? document.metadata.labels?.["infraenv.dev/rack-count"] ?? 1);
  const totalNodes = document.spec.nodes.reduce((sum, item) => sum + (item.count ?? 1), 0);
  return {
    id: document.metadata.id,
    revision,
    name: document.metadata.name,
    description: document.metadata.description ?? "",
    seed: document.spec.seed,
    source: document.spec.presetRef
      ? { kind: "template", templateId: document.spec.presetRef.id, version: document.spec.presetRef.version }
      : document.metadata.labels?.["infraenv.dev/derived-from-preset"]
        ? { kind: "template", templateId: document.metadata.labels["infraenv.dev/derived-from-preset"].split("@")[0]!, version: document.metadata.labels["infraenv.dev/derived-from-preset"].split("@")[1]! }
        : { kind: "playground" },
    inventory: { rackCount: racks, nodesPerRack: document.spec.placement?.nodesPerRack ?? Math.max(1, Math.ceil(totalNodes / racks)), acceleratorsPerNode: accelerator?.count ?? 0, acceleratorModel: accelerator?.acceleratorRef.id ?? "none" },
    topology: {
      intraNode: accelerator?.interconnectTopology === "switch" ? "nvswitch" : accelerator?.interconnect === "pcie" || accelerator?.interconnectTopology === "pcie-only" ? "pcie" : "nvlink",
      nvlinkGeneration: accelerator?.interconnectGeneration ?? "custom-modeled",
      interNode: fabric?.kind === "ethernet" ? "ethernet" : "infiniband",
      interRack: fabric && ["fat-tree", "rail-optimized", "dragonfly"].includes(fabric.topology) ? fabric.topology as "fat-tree" | "rail-optimized" | "dragonfly" : "fat-tree"
    },
    workspace: { persistent: document.metadata.labels?.["infraenv.dev/workspace-persistent-requested"] === "true" },
    objectStorage: { mode: document.spec.storage.some((item) => item.kind === "object") ? "simulated" : "disabled" }
  };
}

function resources(document: EnvironmentDocument) {
  const graph = parseHardwareGraph(document);
  return {
    racks: graph.nodes.filter((node) => node.kind === "rack").length,
    nodes: graph.totals.systems,
    accelerators: graph.totals.accelerators,
    ...(graph.nodes.find((node) => node.kind === "gpu") ? { acceleratorModel: String(graph.nodes.find((node) => node.kind === "gpu")?.attributes.model) } : {}),
    ...(document.spec.fabrics[0] ? { fabric: document.spec.fabrics[0].kind } : {})
  };
}

async function environmentRevision(registry: EnvironmentRegistry, id: EnvironmentId): Promise<number> {
  return (await registry.listSnapshots(id)).at(-1)?.metadata.revision ?? 1;
}

async function environmentSummary(registry: EnvironmentRegistry, document: EnvironmentDocument) {
  const instances = await registry.listInstances();
  const active = instances.find((item) => item.metadata.environmentId === document.metadata.id && item.state !== "stopped" && item.state !== "failed");
  return {
    id: document.metadata.id,
    name: document.metadata.name,
    ...(document.metadata.description ? { description: document.metadata.description } : {}),
    mode: document.metadata.labels?.["infraenv.dev/mode"] === "course" ? "course" : "playground",
    revision: await environmentRevision(registry, document.metadata.id),
    updatedAt: document.metadata.updatedAt,
    ...(document.spec.presetRef
      ? { sourceLabel: `${document.spec.presetRef.id}@${document.spec.presetRef.version}` }
      : document.metadata.labels?.["infraenv.dev/derived-from-preset"]
        ? { sourceLabel: `DERIVED / CUSTOM from ${document.metadata.labels["infraenv.dev/derived-from-preset"]}` }
        : document.spec.scenarioRef ? { sourceLabel: `${document.spec.scenarioRef.id}@${document.spec.scenarioRef.version}` }
          : document.metadata.labels?.["infraenv.dev/accelerator-fidelity"] === "custom-unverified" ? { sourceLabel: "CUSTOM / UNVERIFIED" } : {}),
    resources: resources(document),
    ...(active ? { activeInstanceId: active.metadata.id } : {}),
    ...(document.metadata.labels?.["infraenv.dev/workspace-status"] === "planned-unavailable" ? { limitations: ["Persistent workspace was requested but is planned/unavailable; no volume has been provisioned."] } : {})
  };
}

async function instanceSummary(registry: EnvironmentRegistry, instance: EnvironmentInstance) {
  const snapshot = await registry.getSnapshot(instance.metadata.snapshotId);
  const environment = await registry.getEnvironment(instance.metadata.environmentId).catch((error: unknown) => {
    if (error instanceof RegistryError && error.statusCode === 404) return snapshot.document;
    throw error;
  });
  return {
    apiVersion: instance.apiVersion,
    kind: instance.kind,
    metadata: instance.metadata,
    state: instance.state,
    environmentId: instance.metadata.environmentId,
    snapshotId: instance.metadata.snapshotId,
    snapshotChecksum: snapshot.checksum,
    activeNodeId: instance.activeNodeId,
    boot: instance.boot,
    ...(instance.runtime ? { runtime: instance.runtime } : {}),
    ...(instance.error ? { error: instance.error } : {}),
    id: instance.metadata.id,
    environmentName: environment.metadata.name,
    mode: environment.metadata.labels?.["infraenv.dev/mode"] === "course" ? "course" : "playground",
    status: instance.state,
    definitionRevision: snapshot.metadata.revision,
    startedAt: instance.metadata.createdAt,
    updatedAt: instance.metadata.updatedAt,
    apiReady: instance.state === "ready" || instance.state === "paused",
    resources: resources(snapshot.document)
  };
}

function topology(snapshot: EnvironmentSnapshot) {
  const nodes = snapshot.graph.nodes.filter((node) => node.kind === "node");
  const parentById = new Map(snapshot.graph.nodes.map((node) => [node.id, node.parentId]));
  const belongsTo = (candidateId: string, ancestorId: string): boolean => {
    let current = parentById.get(candidateId);
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      if (current === ancestorId) return true;
      visited.add(current);
      current = parentById.get(current);
    }
    return candidateId.startsWith(`${ancestorId}/`);
  };
  const rackCount = Math.max(1, snapshot.graph.nodes.filter((node) => node.kind === "rack").length);
  const perRack = Math.max(1, Math.ceil(nodes.length / rackCount));
  return [{
    id: "cluster",
    label: snapshot.document.metadata.name,
    kind: "cluster",
    count: 1,
    health: "healthy",
    children: Array.from({ length: rackCount }, (_, rack) => ({
      id: `rack-${rack}`,
      label: `Rack ${rack}`,
      kind: "rack",
      count: 1,
      health: "healthy",
      children: nodes.slice(rack * perRack, (rack + 1) * perRack).map((node) => ({
        id: node.id,
        label: node.id,
        kind: "node",
        count: 1,
        health: "healthy",
        children: [{ id: `${node.id}-gpus`, label: "Accelerators", kind: "accelerator", count: snapshot.graph.nodes.filter((item) => item.kind === "gpu" && belongsTo(item.id, node.id)).length, health: "healthy" }]
      }))
    }))
  }];
}

async function instanceDetail(registry: EnvironmentRegistry, instance: EnvironmentInstance) {
  const [summary, snapshot, checkpoints, availableSnapshots] = await Promise.all([
    instanceSummary(registry, instance),
    registry.getSnapshot(instance.metadata.snapshotId),
    registry.listCheckpoints(instance.metadata.environmentId),
    registry.listSnapshots(instance.metadata.environmentId)
  ]);
  let elapsed = 0;
  const boot = snapshot.boot.phases.map((phase) => {
    elapsed += phase.milliseconds;
    return { id: `boot-${phase.name}`, at: new Date(Date.parse(instance.metadata.createdAt) + elapsed).toISOString(), kind: "boot.phase", phase: phase.name, severity: "info", message: `${phase.name} completed in ${phase.milliseconds} ms (SIMULATED / S2).` };
  });
  const latestRevision = availableSnapshots.at(-1)?.metadata.revision ?? snapshot.metadata.revision;
  const checkpointViews = await Promise.all(checkpoints.map(async (checkpoint) => ({
    id: checkpoint.metadata.id,
    name: checkpoint.metadata.label ?? checkpoint.metadata.id,
    createdAt: checkpoint.metadata.createdAt,
    definitionRevision: (await registry.getSnapshot(checkpoint.snapshotId)).metadata.revision,
    state: "ready"
  })));
  return {
    ...summary,
    disclosure: snapshot.performance.disclosure,
    virtualTimeSeconds: 0,
    topology: topology(snapshot),
    metrics: [
      { id: "compute", label: "Effective compute", value: snapshot.performance.effectiveComputeTflops, unit: "TFLOPS" },
      { id: "network", label: "Effective network", value: snapshot.performance.effectiveNetworkGbps, unit: "Gbps" },
      { id: "collective", label: "Collective latency", value: snapshot.performance.collectiveLatencyMs, unit: "ms" },
      { id: "step", label: "Estimated step time", value: snapshot.performance.estimatedStepTimeMs, unit: "ms" },
      { id: "throughput", label: "Estimated throughput", value: snapshot.performance.estimatedThroughputSamplesPerSecond, unit: "samples/s" }
    ],
    boot,
    events: [{ id: `state-${instance.metadata.id}`, at: instance.metadata.updatedAt, kind: "instance.state", severity: instance.state === "failed" ? "error" : "info", message: `Instance is ${instance.state}.` }],
    faults: [],
    storage: snapshot.document.spec.storage.map((item) => ({ id: item.id, name: item.id, mode: "simulated", status: "disconnected", endpointLabel: item.kind, objectCount: 0, storedBytes: 0, readOnly: true })),
    placements: [],
    checkpoints: checkpointViews,
    ...(latestRevision > snapshot.metadata.revision ? { stagedRevision: latestRevision } : {}),
    capabilities: ["control.pause", "control.resume", "control.reset", "control.restart", "checkpoint.create", "checkpoint.restore", "node.execute", ...(instance.runtime?.containerIds.length ? [] : ["definition.reconcile"])]
  };
}

function unsupported(reply: FastifyReply, capability: keyof typeof UNAVAILABLE_CAPABILITIES) {
  return reply.code(501).send({ error: "capability_unavailable", message: UNAVAILABLE_CAPABILITIES[capability], capability, status: "unavailable" });
}

export function createSupervisor(options: CreateSupervisorOptions): SupervisorApp {
  const token = options.token ?? randomBytes(32).toString("hex");
  const csrfToken = randomBytes(24).toString("hex");
  const sessionToken = randomBytes(32).toString("hex");
  const bundledUiDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/web-ui/dist");
  const webUiDirectory = options.webUiDirectory ? resolve(options.webUiDirectory) : bundledUiDirectory;
  const webUiAvailable = existsSync(join(webUiDirectory, "index.html"));
  let activeWebUiBaseUrl = options.webUiBaseUrl;
  const launchTokens = new Map<string, { expiresAt: number; origin: string }>();
  const tokenDigest = (value: string) => createHash("sha256").update(value).digest("hex");
  const rememberLaunchToken = (value: string, expiresAt: number, origin: string) => {
    for (const [key, record] of launchTokens) if (record.expiresAt <= Date.now()) launchTokens.delete(key);
    launchTokens.set(tokenDigest(value), { expiresAt, origin });
  };
  const issueWebUiLaunch = (baseUrl = activeWebUiBaseUrl ?? "") => {
    if (!baseUrl) throw new RegistryError("webui_url_required", "The caller must provide the actual loopback URL of the running Web UI.", 422);
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new RegistryError("invalid_webui_url", "Web UI URL must use HTTP or HTTPS.", 422);
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) throw new RegistryError("non_loopback_webui_url", "Web UI launch URLs must target the local machine.", 422);
    const value = randomBytes(32).toString("hex");
    const expiresAt = Date.now() + 60_000;
    rememberLaunchToken(value, expiresAt, url.origin);
    url.hash = `launchToken=${encodeURIComponent(value)}`;
    return { url: url.toString(), expiresAt: new Date(expiresAt).toISOString() };
  };
  const instances = options.instances ?? new EnvironmentInstanceManager({ registry: options.registry });
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 8 * 1024 * 1024 }) as unknown as SupervisorApp;
  app.supervisor = { token, csrfToken, sessionToken, registry: options.registry, instances, webUiAvailable, issueWebUiLaunch, setWebUiBaseUrl: (baseUrl) => { activeWebUiBaseUrl = baseUrl; } };

  if (webUiAvailable) {
    void app.register(fastifyStatic, { root: webUiDirectory, prefix: "/app/", redirect: true, index: ["index.html"] });
    app.get("/app", async (_request, reply) => reply.redirect("/app/"));
  }

  app.addContentTypeParser(["text/yaml", "application/yaml", "application/x-yaml"], { parseAs: "string" }, (_request, body, done) => done(null, body));
  app.addHook("onRequest", async (request, reply) => {
    if (isPublic(request)) return;
    const bearerToken = bearer(request);
    const browserSession = cookies(request).infraenv_session;
    const authenticated = Boolean((bearerToken && fixedEqual(bearerToken, token)) || (browserSession && fixedEqual(browserSession, sessionToken)));
    if (!authenticated) return reply.code(401).send({ error: "unauthorized", message: "A valid Supervisor Bearer token or local browser session is required." });
    if (request.method !== "GET" && request.method !== "HEAD" && browserSession) {
      const origin = request.headers.origin;
      let trustedOrigin = false;
      try { trustedOrigin = Boolean(origin && new URL(origin).host === request.headers.host && ["http:", "https:"].includes(new URL(origin).protocol)); } catch { trustedOrigin = false; }
      if (!trustedOrigin) return reply.code(403).send({ error: "origin_failed", message: "Browser mutations require a same-origin request." });
      if (!fixedEqual(String(request.headers["x-infraenv-csrf"] ?? ""), csrfToken)) return reply.code(403).send({ error: "csrf_failed", message: "The local browser session requires the current CSRF token." });
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RegistryError || error instanceof InstanceManagerError) return reply.code(error.statusCode).send({ error: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) });
    if (error instanceof RuntimeDriverError) return reply.code(503).send({ error: error.code, message: error.message });
    const failure = error as { statusCode?: number; message?: string };
    if (failure.statusCode) return reply.code(failure.statusCode).send({ error: "request_failed", message: failure.message ?? "Request failed." });
    return reply.code(500).send({ error: "internal_error", message: failure.message ?? "Unexpected Supervisor error." });
  });

  app.get(`${API_PREFIX}/health`, async () => ({ ok: true, apiVersion: "v1", runtimeVersion: RUNTIME_VERSION }));
  app.get(`${API_PREFIX}/status`, async () => ({ apiVersion: "v1", runtimeVersion: RUNTIME_VERSION, hostname: hostname(), csrfToken, capabilities: [...SUPPORTED_CAPABILITIES, ...(webUiAvailable ? ["webui.launch"] : [])] }));
  app.post<{ Body: { launchToken?: string } }>(`${API_PREFIX}/auth/exchange`, async (request, reply) => {
    const supplied = request.body?.launchToken;
    const digest = supplied ? tokenDigest(supplied) : "";
    const record = launchTokens.get(digest);
    if (!supplied || !record || record.expiresAt <= Date.now()) return reply.code(401).send({ error: "invalid_launch_token", message: "Launch token is invalid, expired, or already used." });
    if (!request.headers.origin || request.headers.origin !== record.origin) return reply.code(403).send({ error: "launch_origin_failed", message: "Launch token must be exchanged by the loopback Web UI origin it was issued for." });
    launchTokens.delete(digest);
    reply.header("set-cookie", `infraenv_session=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=Strict; Path=${API_PREFIX}`);
    return { authenticated: true, expires: "supervisor-stop", csrfToken };
  });
  app.post<{ Body: { baseUrl?: string; url?: string } }>(`${API_PREFIX}/auth/webui-launch`, async (request) => issueWebUiLaunch(request.body?.baseUrl ?? request.body?.url));
  app.post<{ Body: { baseUrl?: string; url?: string } }>(`${API_PREFIX}/auth/launch`, async (request) => issueWebUiLaunch(request.body?.baseUrl ?? request.body?.url));
  app.get(`${API_PREFIX}/capabilities`, async () => {
    const runtime = await instances.capabilities();
    return { apiVersion: "v1", supported: [...SUPPORTED_CAPABILITIES, ...(webUiAvailable ? ["webui.launch"] : [])], unavailable: Object.fromEntries(Object.entries(UNAVAILABLE_CAPABILITIES).map(([capability, reason]) => [capability, { status: "unavailable", reason }])), runtime, webUi: { available: webUiAvailable, ...(webUiAvailable ? { path: "/app/" } : {}) } };
  });
  app.get(`${API_PREFIX}/presets`, async () => ({ items: presetSummaries(), source: "curriculum" }));
  app.get<{ Params: { presetId: string } }>(`${API_PREFIX}/presets/:presetId`, async (request) => resolvePreset(decodeURIComponent(request.params.presetId)));

  app.get<{ Querystring: { raw?: string } }>(`${API_PREFIX}/environments`, async (request) => {
    const documents = await options.registry.listEnvironments();
    return request.query.raw === "true" ? documents : { items: await Promise.all(documents.map((document) => environmentSummary(options.registry, document))) };
  });
  app.post<{ Body: EnvironmentDraft | EnvironmentDocument | { document: EnvironmentDocument } }>(`${API_PREFIX}/environments`, async (request) => {
    const input = "document" in request.body && isEnvironmentDocument(request.body.document) ? request.body.document : request.body;
    const document = isEnvironmentDocument(input) ? input : draftToDocument(input as EnvironmentDraft);
    const created = await options.registry.createEnvironment(document);
    await options.registry.createSnapshot(created.metadata.id, "Definition revision 1");
    return environmentSummary(options.registry, created);
  });
  app.get<{ Params: { environmentId: EnvironmentId }; Querystring: { raw?: string } }>(`${API_PREFIX}/environments/:environmentId`, async (request) => {
    const document = await options.registry.getEnvironment(request.params.environmentId);
    const revision = await environmentRevision(options.registry, request.params.environmentId);
    return request.query.raw === "true" ? document : documentToDraft(document, revision);
  });
  const updateEnvironment = async (request: FastifyRequest<{ Params: { environmentId: EnvironmentId }; Body: EnvironmentDraft | EnvironmentDocument | { document: EnvironmentDocument; expectedUpdatedAt?: string } }>) => {
    const current = await options.registry.getEnvironment(request.params.environmentId);
    const ifMatch = request.headers["if-match"];
    let uiExpectedUpdatedAt: string | undefined;
    if (request.method === "PATCH") {
      if (!ifMatch) throw new RegistryError("precondition_required", "PATCH requires an If-Match definition revision.", 428);
      const parsed = /^(?:W\/)?"?(\d+)"?$/.exec(ifMatch);
      if (!parsed) throw new RegistryError("invalid_if_match", "If-Match must contain a numeric definition revision.", 400);
      if (Number(parsed[1]) !== await environmentRevision(options.registry, request.params.environmentId)) throw new RegistryError("environment_conflict", "Environment revision does not match If-Match.", 409);
      uiExpectedUpdatedAt = current.metadata.updatedAt;
    }
    const body = request.body;
    const input = "document" in body && isEnvironmentDocument(body.document) ? body.document : body;
    const document = isEnvironmentDocument(input) ? input : draftToDocument(input as EnvironmentDraft, request.params.environmentId, current);
    const expected = uiExpectedUpdatedAt ?? ("document" in body && typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : undefined);
    const updated = await options.registry.updateEnvironment(request.params.environmentId, document, expected);
    await options.registry.createSnapshot(updated.metadata.id, "Updated definition");
    return environmentSummary(options.registry, updated);
  };
  app.put<{ Params: { environmentId: EnvironmentId }; Body: EnvironmentDraft | EnvironmentDocument | { document: EnvironmentDocument; expectedUpdatedAt?: string } }>(`${API_PREFIX}/environments/:environmentId`, updateEnvironment);
  app.patch<{ Params: { environmentId: EnvironmentId }; Body: EnvironmentDraft | EnvironmentDocument | { document: EnvironmentDocument; expectedUpdatedAt?: string } }>(`${API_PREFIX}/environments/:environmentId`, updateEnvironment);
  app.delete<{ Params: { environmentId: EnvironmentId } }>(`${API_PREFIX}/environments/:environmentId`, async (request, reply) => { await options.registry.deleteEnvironment(request.params.environmentId); return reply.code(204).send(); });
  app.post<{ Params: { environmentId: EnvironmentId }; Body: { name?: string } }>(`${API_PREFIX}/environments/:environmentId/clone`, async (request) => {
    const source = await options.registry.getEnvironment(request.params.environmentId);
    const now = new Date().toISOString();
    const name = request.body?.name?.trim() || `${source.metadata.name} copy`;
    const clone = structuredClone(source);
    clone.metadata.id = `environment:${slug(name)}-${randomUUID().slice(0, 6)}`;
    clone.metadata.name = name;
    clone.metadata.createdAt = now;
    clone.metadata.updatedAt = now;
    clone.metadata.labels = { ...(clone.metadata.labels ?? {}), "infraenv.dev/cloned-from": source.metadata.id };
    const created = await options.registry.createEnvironment(clone);
    await options.registry.createSnapshot(created.metadata.id, "Definition revision 1");
    return environmentSummary(options.registry, created);
  });
  app.post<{ Params: { environmentId: EnvironmentId }; Querystring: { raw?: string }; Body: { snapshotId?: EnvironmentSnapshotId; nodeId?: string; docker?: boolean } }>(`${API_PREFIX}/environments/:environmentId/start`, async (request) => {
    const instance = await instances.start(request.params.environmentId, request.body ?? {});
    return request.query.raw === "true" ? instance : instanceSummary(options.registry, instance);
  });
  app.post<{ Params: { environmentId: EnvironmentId } }>(`${API_PREFIX}/environments/:environmentId/stop`, async (request) => {
    const active = (await instances.list()).find((item) => item.metadata.environmentId === request.params.environmentId && item.state !== "stopped" && item.state !== "failed");
    if (!active) throw new RegistryError("instance_not_found", `Environment ${request.params.environmentId} has no active instance.`, 404);
    return instanceSummary(options.registry, await instances.stop(active.metadata.id));
  });
  app.post<{ Params: { environmentId: EnvironmentId }; Body: { label?: string } }>(`${API_PREFIX}/environments/:environmentId/snapshots`, async (request) => options.registry.createSnapshot(request.params.environmentId, request.body?.label));
  app.get<{ Params: { environmentId: EnvironmentId } }>(`${API_PREFIX}/environments/:environmentId/snapshots`, async (request) => ({ items: await options.registry.listSnapshots(request.params.environmentId) }));
  app.post<{ Params: { environmentId: EnvironmentId }; Body: { instanceId?: EnvironmentInstanceId; label?: string; payload?: Record<string, unknown> } }>(`${API_PREFIX}/environments/:environmentId/checkpoints`, async (request) => options.registry.createCheckpoint(request.params.environmentId, request.body ?? {}));
  app.get<{ Params: { environmentId: EnvironmentId } }>(`${API_PREFIX}/environments/:environmentId/checkpoints`, async (request) => ({ items: await options.registry.listCheckpoints(request.params.environmentId) }));
  app.get<{ Params: { environmentId: EnvironmentId } }>(`${API_PREFIX}/environments/:environmentId/export`, async (request) => options.registry.exportEnvironment(request.params.environmentId));

  app.get(`${API_PREFIX}/environments/trash`, async () => ({ items: await Promise.all((await options.registry.listTrash()).map(async (entry) => {
    const summary = environmentSummaryFromDocument(entry.document, entry.snapshotIds.length || 1);
    return { ...summary, deletedAt: entry.deletedAt, purgeAt: entry.purgeAfter };
  })) }));
  app.post<{ Params: { environmentId: EnvironmentId } }>(`${API_PREFIX}/environments/trash/:environmentId/restore`, async (request) => environmentSummary(options.registry, await options.registry.restoreEnvironment(request.params.environmentId)));
  app.delete<{ Params: { environmentId: EnvironmentId } }>(`${API_PREFIX}/environments/trash/:environmentId`, async (request) => options.registry.purgeEnvironment(request.params.environmentId));
  app.post<{ Params: { environmentId: EnvironmentId } }>(`${API_PREFIX}/environments/:environmentId/restore`, async (request) => environmentSummary(options.registry, await options.registry.restoreEnvironment(request.params.environmentId)));
  app.delete<{ Params: { environmentId: EnvironmentId } }>(`${API_PREFIX}/environments/:environmentId/purge`, async (request) => options.registry.purgeEnvironment(request.params.environmentId));
  app.get(`${API_PREFIX}/trash`, async () => ({ items: await options.registry.listTrash() }));
  app.post<{ Body: string | EnvironmentExportBundle | { bundle: EnvironmentExportBundle; replace?: boolean } }>(`${API_PREFIX}/environments/import`, async (request) => importResponse(request.body, options.registry));
  app.post<{ Body: string | EnvironmentExportBundle | { bundle: EnvironmentExportBundle; replace?: boolean } }>(`${API_PREFIX}/imports`, async (request) => importResponse(request.body, options.registry));

  app.get<{ Params: { snapshotId: EnvironmentSnapshotId } }>(`${API_PREFIX}/snapshots/:snapshotId`, async (request) => options.registry.getSnapshot(request.params.snapshotId));
  app.get<{ Params: { checkpointId: CheckpointId } }>(`${API_PREFIX}/checkpoints/:checkpointId`, async (request) => options.registry.getCheckpoint(request.params.checkpointId));
  app.post<{ Params: { checkpointId: CheckpointId }; Body: { docker?: boolean } }>(`${API_PREFIX}/checkpoints/:checkpointId/restore`, async (request) => instanceSummary(options.registry, await instances.restoreCheckpoint(request.params.checkpointId, request.body ?? {})));

  app.get<{ Querystring: { raw?: string } }>(`${API_PREFIX}/instances`, async (request) => {
    const values = await instances.list();
    return { items: request.query.raw === "true" ? values : await Promise.all(values.map((instance) => instanceSummary(options.registry, instance))) };
  });
  app.post<{ Querystring: { raw?: string }; Body: { environmentId: EnvironmentId; snapshotId?: EnvironmentSnapshotId; nodeId?: string; docker?: boolean } }>(`${API_PREFIX}/instances`, async (request) => {
    const instance = await instances.start(request.body.environmentId, request.body);
    return request.query.raw === "true" ? instance : instanceSummary(options.registry, instance);
  });
  app.get<{ Params: { instanceId: EnvironmentInstanceId }; Querystring: { raw?: string } }>(`${API_PREFIX}/instances/:instanceId`, async (request) => {
    const instance = await instances.get(request.params.instanceId);
    return request.query.raw === "true" ? instance : instanceDetail(options.registry, instance);
  });
  app.post<{ Params: { instanceId: EnvironmentInstanceId }; Querystring: { raw?: string } }>(`${API_PREFIX}/instances/:instanceId/stop`, async (request) => {
    const instance = await instances.stop(request.params.instanceId);
    return request.query.raw === "true" ? instance : instanceSummary(options.registry, instance);
  });
  for (const action of ["pause", "resume", "reset"] as const) app.post<{ Params: { instanceId: EnvironmentInstanceId }; Querystring: { raw?: string } }>(`${API_PREFIX}/instances/:instanceId/${action}`, async (request) => {
    const instance = await instances.control(request.params.instanceId, action);
    return request.query.raw === "true" ? instance : instanceSummary(options.registry, instance);
  });
  app.post<{ Params: { instanceId: EnvironmentInstanceId }; Querystring: { raw?: string } }>(`${API_PREFIX}/instances/:instanceId/restart`, async (request) => {
    const current = await instances.get(request.params.instanceId);
    const docker = Boolean(current.runtime?.containerIds.length);
    await instances.stop(current.metadata.id);
    const restarted = await instances.start(current.metadata.environmentId, { docker });
    return request.query.raw === "true" ? restarted : instanceSummary(options.registry, restarted);
  });
  app.post<{ Params: { instanceId: EnvironmentInstanceId }; Querystring: { raw?: string }; Body: { command: string; nodeId?: string } }>(`${API_PREFIX}/instances/:instanceId/execute`, async (request) => {
    const execution = await instances.execute(request.params.instanceId, request.body.command, request.body.nodeId);
    return request.query.raw === "true" ? execution.result : execution;
  });
  app.post<{ Params: { instanceId: EnvironmentInstanceId }; Querystring: { raw?: string }; Body: { nodeId: string } }>(`${API_PREFIX}/instances/:instanceId/node`, async (request) => {
    const instance = await instances.selectNode(request.params.instanceId, request.body.nodeId);
    return request.query.raw === "true" ? instance : instanceSummary(options.registry, instance);
  });
  app.post<{ Params: { instanceId: EnvironmentInstanceId }; Querystring: { raw?: string }; Body: { name?: string; label?: string; payload?: Record<string, unknown> } }>(`${API_PREFIX}/instances/:instanceId/checkpoints`, async (request) => {
    const checkpoint = await instances.createCheckpoint(request.params.instanceId, request.body?.label ?? request.body?.name, request.body?.payload);
    if (request.query.raw === "true" || (request.body?.label && !request.body.name)) return checkpoint;
    return instanceDetail(options.registry, await instances.get(request.params.instanceId));
  });
  app.post<{ Params: { instanceId: EnvironmentInstanceId; checkpointId: CheckpointId } }>(`${API_PREFIX}/instances/:instanceId/checkpoints/:checkpointId/restore`, async (request) => instanceDetail(options.registry, await instances.restoreCheckpointInto(request.params.instanceId, request.params.checkpointId)));
  app.post<{ Params: { instanceId: EnvironmentInstanceId } }>(`${API_PREFIX}/instances/:instanceId/reconcile`, async (request) => instanceDetail(options.registry, await instances.reconcileDefinition(request.params.instanceId)));
  app.post(`${API_PREFIX}/instances/:instanceId/storage/connect`, async (_request, reply) => unsupported(reply, "storage.connect"));
  app.post(`${API_PREFIX}/instances/:instanceId/storage/loads`, async (_request, reply) => unsupported(reply, "storage.symbolic-load"));
  app.post(`${API_PREFIX}/instances/:instanceId/terminal-ticket`, async (_request, reply) => unsupported(reply, "terminal.attach"));
  app.post(`${API_PREFIX}/instances/:instanceId/faults`, async (_request, reply) => unsupported(reply, "fault.inject"));
  app.delete(`${API_PREFIX}/instances/:instanceId/faults/:faultId`, async (_request, reply) => unsupported(reply, "fault.inject"));

  return app;
}

function environmentSummaryFromDocument(document: EnvironmentDocument, revision: number) {
  return {
    id: document.metadata.id,
    name: document.metadata.name,
    ...(document.metadata.description ? { description: document.metadata.description } : {}),
    mode: document.metadata.labels?.["infraenv.dev/mode"] === "course" ? "course" : "playground",
    revision,
    updatedAt: document.metadata.updatedAt,
    resources: resources(document)
  };
}

async function importResponse(body: string | EnvironmentExportBundle | { bundle: EnvironmentExportBundle; replace?: boolean }, registry: EnvironmentRegistry) {
  let value: EnvironmentExportBundle | { bundle: EnvironmentExportBundle; replace?: boolean };
  if (typeof body === "string") {
    try { value = JSON.parse(body) as EnvironmentExportBundle; }
    catch { throw new RegistryError("unsupported_import_syntax", "v0.2 accepts JSON export bundles (JSON is also valid YAML); general YAML parsing is not enabled.", 422); }
  } else value = body;
  const bundle = "bundle" in value ? value.bundle : value;
  const replace = "bundle" in value ? value.replace : undefined;
  return environmentSummary(registry, await registry.importEnvironment(bundle, replace === undefined ? {} : { replace }));
}

export async function createLocalSupervisor(options: LocalSupervisorOptions = {}): Promise<SupervisorApp> {
  const dataDirectory = options.dataDirectory ?? process.env.INFRAENV_DATA_DIR ?? join(homedir(), ".infraenv", "supervisor");
  const gateway = new StorageGateway(new LocalFilesystemBackend(dataDirectory), { namespace: "registry", maxObjectBytes: 8 * 1024 * 1024, allowedContentTypes: ["application/json"] });
  const registry = new EnvironmentRegistry({ gateway, trashRetentionDays: 7 });
  await registry.initialize();
  const instances = new EnvironmentInstanceManager({ registry, maximumActiveInstances: options.maximumActiveInstances ?? 4, modelDriver: new ModelOnlyDriver(), dockerDriver: new DockerContainerDriver(options.dockerImage ? { image: options.dockerImage } : {}) });
  if (options.reconcilePersistedInstances ?? true) await instances.reconcilePersistedInstances();
  return createSupervisor({ registry, instances, ...(options.token ? { token: options.token } : {}), ...(options.webUiBaseUrl ? { webUiBaseUrl: options.webUiBaseUrl } : {}), ...(options.webUiDirectory ? { webUiDirectory: options.webUiDirectory } : {}), ...(options.logger === undefined ? {} : { logger: options.logger }) });
}

export async function startSupervisor(options: StartSupervisorOptions = {}): Promise<RunningSupervisor> {
  const app = await createLocalSupervisor(options);
  const host = options.host ?? "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    await app.close();
    throw new RegistryError("non_loopback_bind", `Supervisor refuses to bind non-loopback host ${host}.`, 422);
  }
  const address = await app.listen({ host: host === "[::1]" ? "::1" : host, port: options.port ?? 7331 });
  if (app.supervisor.webUiAvailable && !options.webUiBaseUrl) app.supervisor.setWebUiBaseUrl(`${address}/app/`);
  return { app, address, ...app.supervisor, close: () => app.close() };
}

export async function runtimeCapabilities(app: SupervisorApp): Promise<{ drivers: RuntimeDriverCapabilities[] }> {
  const capabilities = await app.supervisor.instances.capabilities();
  return { drivers: capabilities.drivers };
}
