/** SPDX-License-Identifier: Apache-2.0 */

export type NamespacedId = `${string}:${string}`;
export type Locale = "zh-CN" | "en";
export type SemVer = `${number}.${number}.${number}` | `${number}.${number}.${number}-${string}`;
export type Stage = "foundations" | "systems-parallel" | "gpu-infra";
export type Direction =
  | "parallel"
  | "hpc"
  | "gpu"
  | "distributed-training"
  | "inference"
  | "network-cluster";
export type Difficulty = "beginner" | "intermediate" | "advanced";
export type KnowledgeLayer = "foundation" | "systems" | "parallel" | "cluster" | "ai-infra";
export type SoftwareCategory =
  | "compiler-build"
  | "parallel"
  | "gpu"
  | "communication"
  | "framework"
  | "operator-inference"
  | "environment"
  | "observability"
  | "scheduler";
export type SoftwareStatus = "active" | "mature" | "legacy";
export type SoftwareEcosystem =
  | "cross-platform"
  | "nvidia"
  | "amd"
  | "intel"
  | "linux"
  | "cloud-native";
export type SimulationLevel = "S0" | "S1" | "S2" | "S3" | "S4";
export type TemplateFidelity = "exact" | "derived" | "freeform";

export interface VersionedRef<Id extends NamespacedId = NamespacedId> {
  id: Id;
  version: string;
}

export interface ResourceLink {
  title: string;
  url: string;
  type: "primary" | "supplemental" | "official";
  language: "zh" | "en";
  note: string;
  lastVerified: string;
}

export interface LearningTopic {
  id: `topic:${string}`;
  slug: string;
  title: string;
  englishTitle: string;
  stage: Stage;
  directions: Direction[];
  summary: string;
  outcome: string;
  duration: string;
  hardware: string;
  prerequisiteIds: `topic:${string}`[];
  knowledgeIds: `concept:${string}`[];
  caseIds: `case:${string}`[];
  resources: ResourceLink[];
}

export interface KnowledgeConcept {
  id: `concept:${string}`;
  slug: string;
  label: string;
  englishLabel: string;
  layer: KnowledgeLayer;
  summary: string;
  why: string;
  prerequisites: `concept:${string}`[];
  next: `concept:${string}`[];
  resourceIds: `topic:${string}`[];
  toolIds: `tool:${string}`[];
  caseIds: `case:${string}`[];
}

export interface SoftwareTool {
  id: `tool:${string}`;
  slug: string;
  name: string;
  category: SoftwareCategory;
  summary: string;
  useCase: string;
  difficulty: Difficulty;
  status: SoftwareStatus;
  ecosystems: SoftwareEcosystem[];
  website: string;
  docs: string;
  github?: string;
  knowledgeIds: `concept:${string}`[];
  caseIds: `case:${string}`[];
}

export interface CaseMetadata {
  id: `case:${string}`;
  slug: string;
  title: string;
  englishTitle: string;
  category: "systems" | "parallel" | "gpu" | "communication";
  difficulty: Difficulty;
  duration: string;
  environment: string;
  hardware: string;
  summary: string;
  outcomes: string[];
  prerequisiteIds: `topic:${string}`[];
  toolIds: `tool:${string}`[];
  bodyAsset: string;
}

export interface ContentManifest {
  schemaVersion: string;
  contentVersion: string;
  defaultLocale: "zh-CN";
  supportedLocales: Locale[];
  integrity: Record<string, string>;
}

export interface ProfileManifest {
  profile: "easyinfra" | "runtime";
  schemaVersion: string;
  contentVersion: string;
  catalogSha256: string;
  artifacts: Record<string, string>;
  contentLicense: "CC-BY-4.0";
}

export interface SourceRecord {
  id: `source:${string}`;
  title: string;
  publisher: string;
  url: string;
  verifiedAt: string;
  sourceType: "official";
  note: string;
}

export interface AcceleratorProfile {
  id: `accelerator:${string}`;
  version: string;
  vendor: string;
  model: string;
  architecture: string;
  memory: {
    hbmMiB: number;
    theoreticalBandwidthGBps?: number;
    l2MiB?: number;
    sharedMemoryPerSmKiB?: number;
  };
  thermalDesignPowerWatts?: number;
  nvlink?: {
    generation: string;
    perAcceleratorBidirectionalGBps: number;
  };
  sourceIds: `source:${string}`[];
  fidelity: TemplateFidelity;
  disclosure: string;
}

export interface FabricProfile {
  id: `fabric:${string}`;
  version: string;
  name: string;
  technology: "pcie" | "nvlink" | "nvswitch" | "infiniband" | "roce" | "ethernet";
  generation: string;
  scope: "device" | "intra-node" | "inter-node" | "inter-rack" | "storage";
  theoreticalBandwidthGbps: number;
  bandwidthBasis: "per-direction-data-rate" | "bidirectional-aggregate" | "per-accelerator-bidirectional";
  modeledBaselineLatencyUs: number;
  sourceIds: `source:${string}`[];
  fidelity: TemplateFidelity;
  disclosure: string;
}

export interface ComputeSystemProfile {
  id: `system:${string}`;
  version: string;
  name: string;
  formFactor: "node" | "chassis" | "rack";
  acceleratorRef: VersionedRef<`accelerator:${string}`>;
  structure: {
    /** Compute nodes/trays contained by one instance of this system profile. */
    computeUnitCount: number;
    /** Accelerators installed in each compute node/tray. */
    acceleratorsPerComputeUnit: number;
    /** NVSwitch-bearing baseboards/trays contained by one system instance. */
    switchUnitCount: number;
    /** NVSwitch ASICs installed in each switch baseboard/tray. */
    switchesPerSwitchUnit: number;
    nvlinkDomainSize: number;
    intraSystemTopology: "pcie-only" | "nvlink-bridge-pair" | "nvlink-full-mesh" | "nvswitch";
    nvlinkLinksPerAccelerator?: number;
    nvlinkBridgeAssembliesPerAccelerator?: number;
  };
  intraSystemFabricRefs: VersionedRef<`fabric:${string}`>[];
  cpuSocketsPerComputeUnit?: number;
  hostMemoryMiBPerComputeUnit?: number;
  sourceIds: `source:${string}`[];
  fidelity: TemplateFidelity;
  disclosure: string;
}

export interface BootPhaseDefinition {
  id: `phase:${string}`;
  order: number;
  label: string;
  virtualDurationMs: number;
  checks: string[];
}

export interface BootProfileDefinition {
  id: `boot:${string}`;
  version: string;
  title: string;
  phases: BootPhaseDefinition[];
  sourceIds: `source:${string}`[];
  disclosure: string;
}

export interface SystemGroupDefinition {
  id: `group:${string}`;
  systemRef: VersionedRef<`system:${string}`>;
  /** Number of referenced system instances, not a flattened node count. */
  count: number;
  systemNamePattern: string;
  nodeNamePattern: string;
}

export interface FabricInstanceDefinition {
  id: `fabric-instance:${string}`;
  fabricRef: VersionedRef<`fabric:${string}`>;
  topology: "nvswitch-domain" | "full-mesh" | "fat-tree" | "rail-optimized" | "ring" | "mesh" | "star";
  connectsGroupIds: `group:${string}`[];
  capacityGbps: number;
  oversubscriptionRatio: number;
}

export interface PerformanceModelDefinition {
  modelVersion: "analytical-v1";
  efficiencyRange: [number, number];
  jitterPercent: number;
  disclosure: string;
}

export interface ServiceTemplate {
  id: `service:${string}`;
  kind: "simulated-object-store";
  enabledByDefault: boolean;
  disclosure: string;
}

export interface ClusterPresetDefinition {
  id: `preset:${string}`;
  version: string;
  slug: string;
  title: string;
  fidelity: TemplateFidelity;
  simulationLevel: "S2";
  minRuntimeVersion: string;
  requiredCapabilities: string[];
  seed: number;
  systemGroups: SystemGroupDefinition[];
  fabrics: FabricInstanceDefinition[];
  bootProfileRef: VersionedRef<`boot:${string}`>;
  performanceModel: PerformanceModelDefinition;
  optionalServices: ServiceTemplate[];
  sourceIds: `source:${string}`[];
  disclosure: string;
}

export interface CourseDefinition {
  id: `course:${string}`;
  slug: string;
  title: string;
  englishTitle: string;
  summary: string;
  audience: string;
  chapterIds: `chapter:${string}`[];
}

export interface ChapterDefinition {
  id: `chapter:${string}`;
  slug: string;
  courseId: `course:${string}`;
  title: string;
  englishTitle: string;
  summary: string;
  lessonIds: `lesson:${string}`[];
}

export interface LessonDefinition {
  id: `lesson:${string}`;
  slug: string;
  chapterId: `chapter:${string}`;
  title: string;
  englishTitle: string;
  summary: string;
  duration: string;
  bodyAsset: string;
  prerequisiteTopicIds: `topic:${string}`[];
  teachesConceptIds: `concept:${string}`[];
  usesToolIds: `tool:${string}`[];
  labIds: `lab:${string}`[];
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
  id: `step:${string}`;
  order: number;
  kind: LabStepKind;
  title: string;
  instruction: string;
  command?: string;
  expectedObservation: string;
  hint: string;
}

export type DeclarativeValidator =
  | {
      id: `validator:${string}`;
      kind: "observation-recorded";
      observation: "metrics.network" | "metrics.gpu" | "node.inspect";
    }
  | {
      id: `validator:${string}`;
      kind: "target-inspected";
      target: string;
    }
  | {
      id: `validator:${string}`;
      kind: "diagnosis-matches";
      rootCause: string;
      target: string;
    }
  | {
      id: `validator:${string}`;
      kind: "fault-state";
      faultId: `fault:${string}`;
      state: "active" | "cleared";
    }
  | {
      id: `validator:${string}`;
      kind: "metric-threshold";
      metric: string;
      operator: "gte" | "lte";
      value: number;
      unit: string;
    };

export interface LabDefinition {
  id: `lab:${string}`;
  slug: string;
  title: string;
  lessonId: `lesson:${string}`;
  scenarioRef: VersionedRef<`scenario:${string}`>;
  simulationLevel: SimulationLevel;
  requirements: RuntimeRequirements;
  allowedUiActions: Array<"pause" | "resume" | "reset" | "inject-listed-fault" | "clear-listed-fault">;
  steps: LabStep[];
  validators: DeclarativeValidator[];
}

export interface JobDefinition {
  id: `job:${string}`;
  name: string;
  framework: string;
  nodeCount: number;
  workersPerNode: number;
  baselineStepTimeMs: number;
  baselineThroughputSamplesPerSecond: number;
}

export interface FaultDefinition {
  id: `fault:${string}`;
  kind: "network.bandwidth_drop";
  target: string;
  parameters: {
    fromGbps: number;
    toGbps: number;
  };
}

export interface ScenarioEvent {
  id: `event:${string}`;
  atSeconds: number;
  type: "fault.activate";
  fault: FaultDefinition;
}

export type DeclarativeEnvironmentPatch =
  | {
      id: `patch:${string}`;
      op: "set-link-bandwidth";
      target: string;
      bandwidthGbps: number;
    }
  | {
      id: `patch:${string}`;
      op: "set-device-health";
      target: string;
      health: "healthy" | "degraded" | "offline";
    };

export interface ScenarioDefinition {
  id: `scenario:${string}`;
  version: string;
  title: string;
  presetRef: VersionedRef<`preset:${string}`>;
  seed: number;
  minRuntimeVersion: string;
  requiredCapabilities: string[];
  simulationLevel: SimulationLevel;
  clock: "deterministic-virtual";
  patches: DeclarativeEnvironmentPatch[];
  job?: JobDefinition;
  events: ScenarioEvent[];
  causalModel: Array<{ from: string; to: string; relation: string }>;
}

export type PortableInline =
  | { kind: "text"; value: string }
  | { kind: "inline-code"; value: string }
  | { kind: "strong" | "emphasis" | "delete"; children: PortableInline[] }
  | { kind: "link"; url: string; title?: string; children: PortableInline[] }
  | { kind: "break" };

export type PortableLessonBlock =
  | { kind: "heading"; depth: number; children: PortableInline[] }
  | { kind: "paragraph"; children: PortableInline[] }
  | { kind: "code"; language?: string; meta?: string; value: string }
  | { kind: "blockquote"; children: PortableLessonBlock[] }
  | { kind: "list"; ordered: boolean; start?: number; items: PortableLessonBlock[][] }
  | {
      kind: "component";
      component: "Callout" | "Command" | "LabStep" | "Observation" | "FaultAction" | "Quiz";
      props: Record<string, string>;
      children: PortableLessonBlock[];
    }
  | { kind: "thematic-break" };

export interface PortableLessonDocument {
  schemaVersion: "1.0.0";
  lessonId: `lesson:${string}`;
  locale: Locale;
  sourceAsset: string;
  blocks: PortableLessonBlock[];
}

export interface ContentCatalog {
  manifest: ContentManifest;
  topics: LearningTopic[];
  concepts: KnowledgeConcept[];
  tools: SoftwareTool[];
  cases: CaseMetadata[];
  sources: SourceRecord[];
  accelerators: AcceleratorProfile[];
  fabrics: FabricProfile[];
  systems: ComputeSystemProfile[];
  bootProfiles: BootProfileDefinition[];
  presets: ClusterPresetDefinition[];
  courses: CourseDefinition[];
  chapters: ChapterDefinition[];
  lessons: LessonDefinition[];
  labs: LabDefinition[];
  scenarios: ScenarioDefinition[];
}

export interface RuntimeContentProfile {
  manifest: ContentManifest;
  sources: SourceRecord[];
  accelerators: AcceleratorProfile[];
  fabrics: FabricProfile[];
  systems: ComputeSystemProfile[];
  bootProfiles: BootProfileDefinition[];
  presets: ClusterPresetDefinition[];
  courses: CourseDefinition[];
  chapters: ChapterDefinition[];
  lessons: LessonDefinition[];
  labs: LabDefinition[];
  scenarios: ScenarioDefinition[];
  lessonDocuments: PortableLessonDocument[];
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}
