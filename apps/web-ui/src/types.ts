export type ConnectionMode = "loading" | "supervisor" | "direct-runtime" | "offline" | "error";
export type EnvironmentMode = "playground" | "course";
export type InstanceStatus =
  | "provisioning" | "booting" | "self-testing" | "ready" | "paused"
  | "draining" | "reconciling" | "stopping" | "stopped" | "failed"
  // v0.1 compatibility aliases. New Supervisor responses use ready/failed.
  | "starting" | "running" | "error";

export interface SupervisorStatus {
  apiVersion: string;
  runtimeVersion?: string;
  hostname?: string;
  csrfToken?: string;
  capabilities?: string[];
}

export interface ResourceSummary {
  racks: number;
  nodes: number;
  accelerators: number;
  acceleratorModel?: string;
  fabric?: string;
}

export interface EnvironmentSummary {
  id: string;
  name: string;
  description?: string;
  mode: EnvironmentMode;
  revision: number;
  updatedAt?: string;
  sourceLabel?: string;
  resources: ResourceSummary;
  activeInstanceId?: string;
}

export interface TrashedEnvironment extends EnvironmentSummary {
  deletedAt: string;
  purgeAt: string;
}

export interface PresetSummary {
  id: string;
  version: string;
  name: string;
  description?: string;
  category?: "node" | "rack" | "cluster" | "course";
  verifiedAt?: string;
  fidelity?: "exact" | "derived" | "freeform";
  builderCompatible?: boolean;
  limitation?: string;
  suggestedDraft?: {
    inventory: EnvironmentDraft["inventory"];
    topology: EnvironmentDraft["topology"];
  };
  resources: ResourceSummary;
}

export interface InstanceSummary {
  id: string;
  environmentId: string;
  environmentName: string;
  mode: EnvironmentMode;
  status: InstanceStatus;
  definitionRevision: number;
  startedAt?: string;
  updatedAt?: string;
  apiReady?: boolean;
  resources: ResourceSummary;
}

export interface EnvironmentDraft {
  id?: string;
  revision?: number;
  name: string;
  description: string;
  seed: number;
  source: { kind: "playground" | "template"; templateId?: string; version?: string };
  inventory: {
    rackCount: number;
    nodesPerRack: number;
    acceleratorsPerNode: number;
    acceleratorModel: string;
  };
  topology: {
    intraNode: "pcie" | "nvlink" | "nvswitch";
    nvlinkGeneration: string;
    interNode: "ethernet" | "infiniband";
    interRack: "fat-tree" | "rail-optimized" | "dragonfly";
  };
  bootProfile: "deterministic-post";
  performanceProfile: "bounded-near-theoretical";
  workspace: { persistent: boolean };
  objectStorage: { mode: "disabled" | "simulated" | "s3-proxy"; connectorId?: string };
}

export interface TopologyLayer {
  id: string;
  label: string;
  kind: "cluster" | "rack" | "node" | "accelerator" | "switch" | "service";
  count: number;
  health?: "healthy" | "degraded" | "offline" | "unknown";
  bandwidth?: string;
  latency?: string;
  children?: TopologyLayer[];
}

export interface MetricSample {
  id: string;
  label: string;
  value: number;
  unit: string;
  severity?: "normal" | "warning" | "critical";
  theoreticalMaximum?: number;
}

export interface RuntimeTimelineEvent {
  id: string;
  at: string;
  kind: string;
  message: string;
  phase?: string;
  severity?: "info" | "warning" | "error";
}

export interface FaultView {
  id: string;
  kind: string;
  target: string;
  active: boolean;
  summary?: string;
}

export interface StorageServiceView {
  id: string;
  name: string;
  mode: "simulated" | "s3-proxy";
  status: "ready" | "disconnected" | "error";
  endpointLabel?: string;
  objectCount?: number;
  storedBytes?: number;
  readOnly?: boolean;
}

export interface PlacementView {
  id: string;
  artifact: string;
  strategy: string;
  targets: string[];
  sizeBytes?: number;
  state?: "planned" | "loading" | "resident" | "evicted";
}

export interface CheckpointView {
  id: string;
  name: string;
  createdAt: string;
  definitionRevision: number;
  state: "ready" | "creating" | "restoring" | "incompatible" | "failed";
  sizeBytes?: number;
  compatibilityMessage?: string;
}

export interface CourseContext {
  courseTitle: string;
  chapterTitle?: string;
  lessonTitle?: string;
  currentStep?: number;
  totalSteps?: number;
  steps?: Array<{ id: string; title: string; complete: boolean; command?: string }>;
}

export interface InstanceDetail extends InstanceSummary {
  disclosure: string;
  virtualTimeSeconds?: number;
  stagedRevision?: number;
  topology: TopologyLayer[];
  metrics: MetricSample[];
  boot: RuntimeTimelineEvent[];
  events: RuntimeTimelineEvent[];
  faults: FaultView[];
  faultCatalog?: Array<{ id: string; kind: string; label: string; allowedTargets?: string[] }>;
  storage: StorageServiceView[];
  placements: PlacementView[];
  checkpoints: CheckpointView[];
  course?: CourseContext;
  capabilities?: string[];
}

export interface TerminalTicket {
  websocketUrl: string;
  subprotocol: string;
  expiresAt: string;
}

export interface BootstrapData {
  status: SupervisorStatus;
  environments: EnvironmentSummary[];
  presets: PresetSummary[];
  instances: InstanceSummary[];
  trash: TrashedEnvironment[];
}

export interface ApiCollection<T> { items: T[] }

export const EMPTY_DRAFT: EnvironmentDraft = {
  name: "",
  description: "",
  seed: 240803,
  source: { kind: "playground" },
  inventory: { rackCount: 1, nodesPerRack: 1, acceleratorsPerNode: 8, acceleratorModel: "NVIDIA H100 SXM (SIMULATED)" },
  topology: { intraNode: "nvswitch", nvlinkGeneration: "NVLink 4", interNode: "infiniband", interRack: "fat-tree" },
  bootProfile: "deterministic-post",
  performanceProfile: "bounded-near-theoretical",
  workspace: { persistent: false },
  objectStorage: { mode: "disabled" }
};
