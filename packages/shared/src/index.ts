export const RUNTIME_VERSION = "0.1.0-alpha.0";
export const CONTENT_VERSION = "0.1.0-alpha.0";
export const SCENARIO_VERSION = "1.0.0";
export const SIMULATION_DISCLOSURE = "SIMULATED / S2 — behavioral model, not real HPC performance";

export type SimulationLevel = "S0" | "S1" | "S2" | "S3" | "S4";
export type SessionStatus = "running" | "paused" | "passed" | "stopped";
export type NodeHealth = "healthy" | "degraded" | "offline";
export type Difficulty = "beginner" | "intermediate" | "advanced";

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
  scenarios: ScenarioDefinition[];
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
