export const RUNTIME_VERSION = "0.2.0-alpha.0";
export const CONTENT_VERSION = "0.2.0-alpha.0";
export const SCENARIO_VERSION = "2.0.0";
export const MAX_PLAYGROUND_LOGICAL_GPUS = 4_096;
export const SIMULATION_DISCLOSURE = "SIMULATED / S2 — behavioral model, not real HPC performance";

export type SimulationLevel = "S0" | "S1" | "S2" | "S3" | "S4";
export type SessionStatus = "running" | "paused" | "passed" | "stopped";
export type NodeHealth = "healthy" | "degraded" | "offline";
export type Difficulty = "beginner" | "intermediate" | "advanced";
export type EnvironmentId = `environment:${string}`;
export type EnvironmentSnapshotId = `snapshot:${string}`;
export type EnvironmentInstanceId = `instance:${string}`;
export type CheckpointId = `checkpoint:${string}`;
export type VersionedEntityId = `${string}@${string}`;
export type MemoryPoolId = `memory-pool:${string}`;
export type AllocationId = `allocation:${string}`;
export type ModelArtifactId = `model-artifact:${string}`;
export type TensorShardId = `tensor-shard:${string}`;
export type PlacementPlanId = `placement-plan:${string}`;

/** A logical capacity boundary. No host memory is reserved for capacityBytes. */
export interface MemoryPool {
  id: MemoryPoolId;
  ownerId: string;
  kind: "hbm" | "host-memory" | "object-cache";
  capacityBytes: number;
}

/**
 * A logical, half-open byte range [offsetBytes, offsetBytes + sizeBytes).
 * In a complete PlacementPlan each allocation is exclusively owned by one shard.
 */
export interface Allocation {
  id: AllocationId;
  poolId: MemoryPoolId;
  offsetBytes: number;
  sizeBytes: number;
}

export interface ModelArtifact {
  id: ModelArtifactId;
  name: string;
  format: "safetensors" | "onnx" | "gguf" | "custom";
  sizeBytes: number;
}

/** A tensor shard and its logical placement; byte counts never materialize buffers. */
export interface TensorShard {
  id: TensorShardId;
  artifactId: ModelArtifactId;
  allocationId: AllocationId;
  tensorName: string;
  shardIndex: number;
  shardCount: number;
  artifactOffsetBytes: number;
  sizeBytes: number;
}

/** A complete placement plan; every tensor shard index from 0 to shardCount - 1 must exist. */
export interface PlacementPlan {
  id: PlacementPlanId;
  name: string;
  memoryPools: MemoryPool[];
  artifacts: ModelArtifact[];
  allocations: Allocation[];
  shards: TensorShard[];
}

export type PlacementIssueCode =
  | "duplicate-id"
  | "invalid-byte-range"
  | "missing-pool"
  | "missing-artifact"
  | "missing-allocation"
  | "allocation-out-of-bounds"
  | "allocation-overlap"
  | "allocation-too-small"
  | "allocation-reused"
  | "shard-out-of-bounds"
  | "shard-overlap"
  | "invalid-shard-index"
  | "duplicate-shard-index"
  | "missing-shard-index"
  | "inconsistent-shard-count";

export interface PlacementIssue {
  code: PlacementIssueCode;
  subjectId: string;
  relatedId?: string;
  message: string;
}

export interface MemoryPoolUsage {
  poolId: MemoryPoolId;
  capacityBytes: number;
  allocatedBytes: number;
  placedShardBytes: number;
  freeBytes: number;
  utilizationRatio: number;
}

export interface PlacementLedger {
  planId: PlacementPlanId;
  totalCapacityBytes: number;
  totalAllocatedBytes: number;
  totalPlacedShardBytes: number;
  pools: MemoryPoolUsage[];
}

export type PlacementLedgerResult =
  | {
      ok: true;
      simulationLevel: "S2";
      disclosure: string;
      ledger: PlacementLedger;
      issues: [];
    }
  | {
      ok: false;
      simulationLevel: "S2";
      disclosure: string;
      issues: PlacementIssue[];
    };

export interface VersionedReference {
  id: string;
  version: string;
}

export interface ResolvedEntity<T = Record<string, unknown>> {
  key: VersionedEntityId;
  kind: string;
  value: T;
  source: "curriculum" | "compatibility" | "inline";
}

export interface EnvironmentAcceleratorAttachment {
  id: string;
  acceleratorRef: VersionedReference;
  count: number;
  memoryGiB?: number;
  peakTflops?: number;
  memoryBandwidthGBps?: number;
  powerLimitWatts?: number;
  interconnectBandwidthGBps?: number;
  interconnectGeneration?: string;
  interconnectTopology?: "pcie-only" | "direct" | "switch";
  interconnectSwitchCount?: number;
  interconnect?: "pcie" | "nvlink" | "xgmi" | "integrated";
}

export interface EnvironmentNodeSpec {
  id: string;
  count?: number;
  systemRef?: VersionedReference;
  roles: Array<"compute" | "control" | "storage" | "login">;
  cpuCores: number;
  memoryGiB: number;
  accelerators: EnvironmentAcceleratorAttachment[];
  bootProfileRef?: VersionedReference;
  pcieGeneration?: string;
  pcieBandwidthGbps?: number;
  labels?: Record<string, string>;
}

export interface EnvironmentFabricSpec {
  id: string;
  fabricRef?: VersionedReference;
  kind: "ethernet" | "infiniband" | "nvlink" | "xgmi" | "custom";
  topology: "fat-tree" | "ring" | "mesh" | "fully-connected" | "rail-optimized" | "dragonfly";
  bandwidthGbps: number;
  latencyMicroseconds: number;
  endpointNodeIds: string[];
  oversubscriptionRatio?: number;
}

export interface EnvironmentStorageSpec {
  id: string;
  kind: "local" | "shared" | "object";
  capacityGiB: number;
  readBandwidthGbps: number;
  writeBandwidthGbps: number;
  endpointNodeIds: string[];
}

export interface EnvironmentDocument {
  apiVersion: "infraenv.io/v1alpha1";
  kind: "Environment";
  metadata: {
    id: EnvironmentId;
    name: string;
    description?: string;
    createdAt: string;
    updatedAt: string;
    labels?: Record<string, string>;
  };
  spec: {
    simulationLevel: "S2";
    seed: number;
    presetRef?: VersionedReference;
    scenarioRef?: VersionedReference;
    nodes: EnvironmentNodeSpec[];
    fabrics: EnvironmentFabricSpec[];
    storage: EnvironmentStorageSpec[];
    placement?: { rackCount?: number; nodesPerRack?: number };
    workspace?: { persistence: "ephemeral" | "retained"; capacityGiB?: number; hostConnectorId?: string };
    environment?: Record<string, string>;
  };
}

export interface HardwareGraphNode {
  id: string;
  kind: "cluster" | "rack" | "tray" | "chassis" | "node" | "cpu-numa" | "pcie-root" | "pcie-switch" | "gpu" | "memory" | "nvswitch" | "nic-dpu" | "fabric-switch" | "storage-endpoint";
  parentId?: string;
  attributes: Record<string, string | number | boolean>;
}

export interface HardwareGraphEdge {
  id: string;
  source: string;
  target: string;
  kind: "pcie" | "nvlink" | "nvlink-c2c" | "nvswitch" | "infiniband" | "roce" | "ethernet" | "storage-network";
  relation: "contains" | "connects" | "mounts";
  direction: "bidirectional" | "unidirectional";
  generation?: string;
  sharedGroup?: string;
  oversubscriptionRatio?: number;
  health: "healthy" | "degraded" | "offline";
  bandwidthGbps?: number;
  latencyMicroseconds?: number;
}

export interface HardwareGraph {
  environmentId: EnvironmentId;
  nodes: HardwareGraphNode[];
  edges: HardwareGraphEdge[];
  totals: { systems: number; accelerators: number; cpuCores: number; memoryGiB: number; storageGiB: number };
}

export interface BootModelResult {
  seed: number;
  totalMilliseconds: number;
  phases: Array<{ name: "allocate" | "network" | "storage" | "runtime" | "workload"; milliseconds: number }>;
  warnings: string[];
}

export interface PerformanceModelResult {
  seed: number;
  effectiveComputeTflops: number;
  effectiveNetworkGbps: number;
  collectiveLatencyMs: number;
  estimatedStepTimeMs: number;
  estimatedThroughputSamplesPerSecond: number;
  bottleneck: "compute" | "network" | "storage" | "memory";
  confidence: "behavioral-s2";
  disclosure: string;
}

export interface EnvironmentSnapshot {
  apiVersion: "infraenv.io/v1alpha1";
  kind: "EnvironmentSnapshot";
  metadata: { id: EnvironmentSnapshotId; environmentId: EnvironmentId; revision: number; createdAt: string; label?: string };
  checksum: `sha256-${string}`;
  document: EnvironmentDocument;
  graph: HardwareGraph;
  boot: BootModelResult;
  performance: PerformanceModelResult;
}

export type EnvironmentInstanceState = "provisioning" | "booting" | "self-testing" | "ready" | "paused" | "draining" | "reconciling" | "stopping" | "stopped" | "failed";

export interface EnvironmentInstance {
  apiVersion: "infraenv.io/v1alpha1";
  kind: "EnvironmentInstance";
  metadata: { id: EnvironmentInstanceId; environmentId: EnvironmentId; snapshotId: EnvironmentSnapshotId; createdAt: string; updatedAt: string };
  state: EnvironmentInstanceState;
  activeNodeId: string;
  runtime?: { supervisorUrl?: string; containerIds: string[]; networkNames: string[]; ptyAvailable: boolean };
  boot: BootModelResult;
  error?: string;
}

export interface EnvironmentCheckpoint {
  apiVersion: "infraenv.io/v1alpha1";
  kind: "EnvironmentCheckpoint";
  metadata: { id: CheckpointId; environmentId: EnvironmentId; instanceId?: EnvironmentInstanceId; createdAt: string; label?: string };
  snapshotId: EnvironmentSnapshotId;
  activeNodeId: string;
  virtualTimeSeconds: number;
  payload: Record<string, unknown>;
}

export interface EnvironmentTrashEntry {
  environmentId: EnvironmentId;
  deletedAt: string;
  purgeAfter: string;
  document: EnvironmentDocument;
  snapshotIds: EnvironmentSnapshotId[];
}

export interface EnvironmentExportBundle {
  apiVersion: "infraenv.io/export/v1";
  exportedAt: string;
  environment: EnvironmentDocument;
  snapshots: EnvironmentSnapshot[];
  checkpoints: EnvironmentCheckpoint[];
  integrity: Record<string, `sha256-${string}`>;
}

export interface NodeContext {
  instanceId: EnvironmentInstanceId;
  environmentId: EnvironmentId;
  nodeId: string;
}

export interface ContentManifest {
  schemaVersion: string;
  contentVersion: string;
  defaultLocale: "zh-CN";
  supportedLocales: string[];
  integrity: Record<string, string>;
}

export interface RuntimeRequirements {
  node: ">=22";
  docker: ">=26";
  operatingSystems: string[];
  cpuCores: number;
  memoryMiB: number;
  diskMiB: number;
  realGpuRequired: false;
  networkAccessDuringLab: false;
}

export type LabStepKind = "command" | "observe" | "diagnose" | "repair" | "submit";

export interface LabStep {
  id: string;
  order: number;
  kind: LabStepKind;
  title: string;
  instruction: string;
  command?: string;
  expectedObservation: string;
  hint: string;
}

export type DeclarativeValidator =
  | { id: string; kind: "observation-recorded"; observation: "metrics.network" | "metrics.gpu" | "node.inspect" }
  | { id: string; kind: "target-inspected"; target: string }
  | { id: string; kind: "diagnosis-matches"; rootCause: string; target: string }
  | { id: string; kind: "fault-state"; faultId: string; state: "active" | "cleared" }
  | { id: string; kind: "metric-threshold"; metric: string; operator: "gte" | "lte"; value: number; unit: string };

export interface LessonDefinition {
  id: string;
  slug: string;
  chapterId: string;
  bodyAsset: string;
  prerequisiteTopicIds: string[];
  teachesConceptIds: string[];
  usesToolIds: string[];
  labIds: string[];
}

export interface LabDefinition {
  id: string;
  slug: string;
  title: string;
  lessonId: string;
  scenarioRef: { id: string; version: string };
  simulationLevel: SimulationLevel;
  requirements: RuntimeRequirements;
  allowedUiActions: string[];
  steps: LabStep[];
  validators: DeclarativeValidator[];
}

export interface ClusterDefinition {
  nodeCount: number;
  nodeNamePattern: string;
  gpusPerNode: number;
  gpuModel: string;
  totalGpuCount: number;
  baselineNetworkGbps: number;
  topology: "fat-tree" | "ring" | "mesh";
  disclosure: string;
  acceleratorRef?: VersionedReference;
  systemRef?: VersionedReference;
  bootProfileRef?: VersionedReference;
  fabricRef?: VersionedReference;
  gpuMemoryMiB?: number;
  gpuMemoryBandwidthGBps?: number;
  gpuPowerLimitWatts?: number;
  gpuInterconnectBandwidthGBps?: number;
  gpuInterconnectGeneration?: string;
  gpuInterconnectTopology?: "pcie-only" | "direct" | "switch";
  gpuInterconnectSwitchCount?: number;
  pcieGeneration?: string;
  pcieBandwidthGbps?: number;
}

export interface JobDefinition {
  id: string;
  name: string;
  framework: string;
  nodeCount: number;
  workersPerNode: number;
  baselineStepTimeMs: number;
  baselineThroughputSamplesPerSecond: number;
}

export interface RuntimeJobSnapshot extends JobDefinition {
  state: "RUNNING" | "PENDING" | "FAILED";
  worldSize: number;
}

export interface FaultDefinition {
  id: string;
  kind: "network.bandwidth_drop";
  target: string;
  parameters: { fromGbps: number; toGbps: number };
}

export interface ScenarioEvent {
  id: string;
  atSeconds: number;
  type: "fault.activate";
  fault: FaultDefinition;
}

export interface ScenarioDefinition {
  id: string;
  version: string;
  title: string;
  seed: number;
  minRuntimeVersion: string;
  requiredCapabilities: string[];
  simulationLevel: SimulationLevel;
  clock: "deterministic-virtual";
  cluster: ClusterDefinition;
  job: JobDefinition;
  events: ScenarioEvent[];
  causalModel: Array<{ from: string; to: string; relation: string }>;
}

export interface RuntimeCurriculumProfile {
  manifest: ContentManifest;
  courses: Array<Record<string, unknown>>;
  chapters: Array<Record<string, unknown>>;
  lessons: LessonDefinition[];
  labs: LabDefinition[];
  /** Canonical Scenario documents are curriculum-owned and resolved at runtime. */
  scenarios: Array<Record<string, unknown>>;
  accelerators?: Array<Record<string, unknown>>;
  systems?: Array<Record<string, unknown>>;
  fabrics?: Array<Record<string, unknown>>;
  bootProfiles?: Array<Record<string, unknown>>;
  presets?: Array<Record<string, unknown>>;
  lessonDocuments?: Array<Record<string, unknown>>;
  sources?: Array<Record<string, unknown>>;
}

export interface GpuMetric {
  index: number;
  model: string;
  utilizationPercent: number;
  memoryUsedMiB: number;
  memoryTotalMiB: number;
  temperatureC: number;
  powerWatts: number;
}

export interface NetworkMetric {
  bandwidthGbps: number;
  utilizationPercent: number;
  latencyMs: number;
  retransmitsPerSecond: number;
}

export interface NodeSnapshot {
  id: string;
  rank: number;
  health: NodeHealth;
  network: NetworkMetric;
  gpus: GpuMetric[];
  communicationWaitMs: number;
}

export interface TrainingMetric {
  stepTimeMs: number;
  throughputSamplesPerSecond: number;
  collectiveTimeMs: number;
  synchronizationWaitMs: number;
}

export interface FaultState {
  id: string;
  type: "network.bandwidth_drop";
  target: string;
  active: boolean;
  injectedAtSeconds: number;
  clearedAtSeconds?: number;
}

export interface ObservationState {
  commands: string[];
  inspectedNodes: string[];
  metricGroups: string[];
}

export interface Hypothesis {
  rootCause: string;
  target: string;
}

export interface SimulationSnapshot {
  sessionId: string;
  scenarioId: string;
  scenarioVersion: string;
  simulationLevel: SimulationLevel;
  allowedUiActions: string[];
  disclosure: string;
  seed: number;
  virtualTimeSeconds: number;
  revision: number;
  status: SessionStatus;
  nodes: NodeSnapshot[];
  job: RuntimeJobSnapshot;
  training: TrainingMetric;
  faults: FaultState[];
  observations: ObservationState;
  hypothesis?: Hypothesis;
}

export interface ValidationCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface ValidationResult {
  passed: boolean;
  checks: ValidationCheck[];
  summary: string;
}

export interface CommandResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  revision: number;
}

export interface SessionTokens {
  hostToken: string;
  sandboxToken: string;
  uiLaunchToken: string;
}

export interface LearningRecord {
  recordedAt: string;
  sessionId: string;
  contentVersion: string;
  runtimeVersion: string;
  scenarioId: string;
  scenarioVersion: string;
  curriculumChecksum: string;
  event: "session.started" | "command.executed" | "control.changed" | "fault.injected" | "fault.cleared" | "lab.submitted" | "session.stopped";
  payload: Record<string, unknown>;
}

export interface RuntimeEvent {
  type: "state" | "command" | "validation" | "notice";
  at: string;
  data: unknown;
}

export function createSessionId(now = Date.now()): string {
  return `session-${now.toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}
