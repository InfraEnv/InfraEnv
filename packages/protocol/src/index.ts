import AjvModule, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import {
  MAX_PLAYGROUND_LOGICAL_GPUS,
  type ContentManifest,
  type EnvironmentDocument,
  type EnvironmentInstance,
  type EnvironmentSnapshot,
  type LabDefinition,
  type ScenarioDefinition
} from "@infraenv/shared";

export const namespaceIdPattern = "^(course|chapter|lesson|lab|scenario|topic|concept|tool):[a-z0-9]+(?:-[a-z0-9]+)*$";

const scenarioVersionedReferenceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "version"],
  properties: {
    id: { type: "string", minLength: 1 },
    version: { type: "string", pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[a-z0-9.-]+)?$" }
  }
} as const;

export const scenarioSchema = {
  $id: "https://infraenv.dev/schema/scenario-1.json",
  type: "object",
  additionalProperties: false,
  required: ["id", "version", "title", "seed", "minRuntimeVersion", "requiredCapabilities", "simulationLevel", "clock", "cluster", "job", "events", "causalModel"],
  properties: {
    id: { type: "string", pattern: "^scenario:[a-z0-9]+(?:-[a-z0-9]+)*$" },
    version: { type: "string", pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[a-z0-9.-]+)?$" },
    title: { type: "string", minLength: 1 },
    seed: { type: "integer", minimum: 0 },
    minRuntimeVersion: { type: "string" },
    requiredCapabilities: { type: "array", uniqueItems: true, items: { type: "string" } },
    simulationLevel: { const: "S2" },
    clock: { const: "deterministic-virtual" },
    cluster: {
      type: "object",
      additionalProperties: false,
      required: ["nodeCount", "nodeNamePattern", "gpusPerNode", "gpuModel", "totalGpuCount", "baselineNetworkGbps", "topology", "disclosure"],
      properties: {
        nodeCount: { type: "integer", minimum: 1, maximum: 1024 },
        nodeNamePattern: { type: "string" },
        gpusPerNode: { type: "integer", minimum: 1, maximum: 16 },
        gpuModel: { type: "string", minLength: 1 },
        totalGpuCount: { type: "integer", minimum: 1 },
        baselineNetworkGbps: { type: "number", exclusiveMinimum: 0 },
        topology: { enum: ["fat-tree", "ring", "mesh"] },
        disclosure: { type: "string", minLength: 1 },
        acceleratorRef: scenarioVersionedReferenceSchema,
        systemRef: scenarioVersionedReferenceSchema,
        bootProfileRef: scenarioVersionedReferenceSchema,
        fabricRef: scenarioVersionedReferenceSchema,
        gpuMemoryMiB: { type: "number", exclusiveMinimum: 0 },
        gpuMemoryBandwidthGBps: { type: "number", exclusiveMinimum: 0 },
        gpuPowerLimitWatts: { type: "number", exclusiveMinimum: 0 },
        gpuInterconnectBandwidthGBps: { type: "number", exclusiveMinimum: 0 },
        gpuInterconnectGeneration: { type: "string", minLength: 1 },
        gpuInterconnectTopology: { enum: ["pcie-only", "direct", "switch"] },
        gpuInterconnectSwitchCount: { type: "integer", minimum: 0 },
        pcieGeneration: { type: "string", minLength: 1 },
        pcieBandwidthGbps: { type: "number", exclusiveMinimum: 0 }
      }
    },
    job: {
      type: "object",
      additionalProperties: false,
      required: ["id", "name", "framework", "nodeCount", "workersPerNode", "baselineStepTimeMs", "baselineThroughputSamplesPerSecond"],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        framework: { type: "string" },
        nodeCount: { type: "integer", minimum: 1 },
        workersPerNode: { type: "integer", minimum: 1 },
        baselineStepTimeMs: { type: "number", exclusiveMinimum: 0 },
        baselineThroughputSamplesPerSecond: { type: "number", exclusiveMinimum: 0 }
      }
    },
    events: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "atSeconds", "type", "fault"],
        properties: {
          id: { type: "string" },
          atSeconds: { type: "number", minimum: 0 },
          type: { const: "fault.activate" },
          fault: {
            type: "object", additionalProperties: false, required: ["id", "kind", "target", "parameters"],
            properties: {
              id: { type: "string", pattern: "^fault:" },
              kind: { const: "network.bandwidth_drop" },
              target: { type: "string" },
              parameters: {
                type: "object", additionalProperties: false, required: ["fromGbps", "toGbps"],
                properties: { fromGbps: { type: "number" }, toGbps: { type: "number" } }
              }
            }
          }
        }
      }
    },
    causalModel: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["from", "to", "relation"],
        properties: { from: { type: "string" }, to: { type: "string" }, relation: { type: "string" } }
      }
    }
  }
} as const;

export const manifestSchema = {
  $id: "https://infraenv.dev/schema/manifest-1.json",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "contentVersion", "defaultLocale", "supportedLocales", "integrity"],
  properties: {
    schemaVersion: { type: "string" },
    contentVersion: { type: "string" },
    defaultLocale: { const: "zh-CN" },
    supportedLocales: { type: "array", contains: { const: "zh-CN" }, items: { type: "string" } },
    integrity: { type: "object", additionalProperties: { type: "string", pattern: "^sha256-[a-f0-9]{64}$" } }
  }
} as const;

export const labSchema = {
  $id: "https://infraenv.dev/schema/lab-1.json",
  type: "object",
  additionalProperties: false,
  required: ["id", "slug", "title", "lessonId", "scenarioRef", "simulationLevel", "requirements", "allowedUiActions", "steps", "validators"],
  properties: {
    id: { type: "string", pattern: "^lab:[a-z0-9]+(?:-[a-z0-9]+)*$" },
    slug: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
    title: { type: "string", minLength: 1 },
    scenarioRef: {
      type: "object", additionalProperties: false, required: ["id", "version"],
      properties: { id: { type: "string", pattern: "^scenario:" }, version: { type: "string" } }
    },
    simulationLevel: { enum: ["S0", "S1", "S2", "S3", "S4"] },
    lessonId: { type: "string", pattern: "^lesson:" },
    requirements: { type: "object" },
    allowedUiActions: { type: "array", uniqueItems: true, items: { type: "string" } },
    steps: { type: "array", minItems: 1, items: { type: "object" } },
    validators: { type: "array", minItems: 1, items: { type: "object" } }
  }
} as const;

const versionedReferenceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "version"],
  properties: {
    id: { type: "string", minLength: 1 },
    version: { type: "string", pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[a-z0-9.-]+)?$" }
  }
} as const;

export const environmentSchema = {
  $id: "https://infraenv.dev/schema/environment-v1alpha1.json",
  type: "object",
  additionalProperties: false,
  required: ["apiVersion", "kind", "metadata", "spec"],
  properties: {
    apiVersion: { const: "infraenv.io/v1alpha1" },
    kind: { const: "Environment" },
    metadata: {
      type: "object",
      additionalProperties: false,
      required: ["id", "name", "createdAt", "updatedAt"],
      properties: {
        id: { type: "string", pattern: "^environment:[a-z0-9]+(?:-[a-z0-9]+)*$" },
        name: { type: "string", minLength: 1, maxLength: 120 },
        description: { type: "string", maxLength: 1000 },
        createdAt: { type: "string" },
        updatedAt: { type: "string" },
        labels: { type: "object", propertyNames: { pattern: "^[a-z0-9][a-z0-9._/-]{0,62}$" }, additionalProperties: { type: "string", maxLength: 256 } }
      }
    },
    spec: {
      type: "object",
      additionalProperties: false,
      required: ["simulationLevel", "seed", "nodes", "fabrics", "storage"],
      properties: {
        simulationLevel: { const: "S2" },
        seed: { type: "integer", minimum: 0, maximum: 4294967295 },
        presetRef: versionedReferenceSchema,
        scenarioRef: versionedReferenceSchema,
        environment: { type: "object", propertyNames: { pattern: "^[A-Z_][A-Z0-9_]*$" }, additionalProperties: { type: "string", maxLength: 4096 } },
        nodes: {
          type: "array", minItems: 1, maxItems: 256,
          items: {
            type: "object", additionalProperties: false,
            required: ["id", "roles", "cpuCores", "memoryGiB", "accelerators"],
            properties: {
              id: { type: "string", pattern: "^[a-z][a-z0-9-]{0,62}$" },
              count: { type: "integer", minimum: 1, maximum: 1024 },
              systemRef: versionedReferenceSchema,
              bootProfileRef: versionedReferenceSchema,
              pcieGeneration: { type: "string", minLength: 1 },
              pcieBandwidthGbps: { type: "number", exclusiveMinimum: 0 },
              roles: { type: "array", minItems: 1, uniqueItems: true, items: { enum: ["compute", "control", "storage", "login"] } },
              cpuCores: { type: "integer", minimum: 1, maximum: 8192 },
              memoryGiB: { type: "number", exclusiveMinimum: 0, maximum: 1048576 },
              labels: { type: "object", additionalProperties: { type: "string" } },
              accelerators: {
                type: "array", maxItems: 32,
                items: {
                  type: "object", additionalProperties: false,
                  required: ["id", "acceleratorRef", "count"],
                  properties: {
                    id: { type: "string", pattern: "^[a-z][a-z0-9-]{0,62}$" },
                    acceleratorRef: versionedReferenceSchema,
                    count: { type: "integer", minimum: 1, maximum: 64 },
                    memoryGiB: { type: "number", exclusiveMinimum: 0 },
                    peakTflops: { type: "number", exclusiveMinimum: 0 },
                    memoryBandwidthGBps: { type: "number", exclusiveMinimum: 0 },
                    powerLimitWatts: { type: "number", exclusiveMinimum: 0 },
                    interconnectBandwidthGBps: { type: "number", exclusiveMinimum: 0 },
                    interconnectGeneration: { type: "string", minLength: 1 },
                    interconnectTopology: { enum: ["pcie-only", "direct", "switch"] },
                    interconnectSwitchCount: { type: "integer", minimum: 0, maximum: 128 },
                    interconnect: { enum: ["pcie", "nvlink", "xgmi", "integrated"] }
                  }
                }
              }
            }
          }
        },
        fabrics: {
          type: "array", maxItems: 128,
          items: {
            type: "object", additionalProperties: false,
            required: ["id", "kind", "topology", "bandwidthGbps", "latencyMicroseconds", "endpointNodeIds"],
            properties: {
              id: { type: "string" }, fabricRef: versionedReferenceSchema,
              kind: { enum: ["ethernet", "infiniband", "nvlink", "xgmi", "custom"] },
              topology: { enum: ["fat-tree", "ring", "mesh", "fully-connected", "rail-optimized", "dragonfly"] },
              bandwidthGbps: { type: "number", exclusiveMinimum: 0 },
              latencyMicroseconds: { type: "number", minimum: 0 },
              endpointNodeIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string" } },
              oversubscriptionRatio: { type: "number", minimum: 1 }
            }
          }
        },
        placement: {
          type: "object", additionalProperties: false,
          properties: { rackCount: { type: "integer", minimum: 1, maximum: 1024 }, nodesPerRack: { type: "integer", minimum: 1, maximum: 1024 } }
        },
        workspace: {
          type: "object", additionalProperties: false, required: ["persistence"],
          properties: { persistence: { enum: ["ephemeral", "retained"] }, capacityGiB: { type: "number", exclusiveMinimum: 0 }, hostConnectorId: { type: "string", minLength: 1 } }
        },
        storage: {
          type: "array", maxItems: 64,
          items: {
            type: "object", additionalProperties: false,
            required: ["id", "kind", "capacityGiB", "readBandwidthGbps", "writeBandwidthGbps", "endpointNodeIds"],
            properties: {
              id: { type: "string" }, kind: { enum: ["local", "shared", "object"] },
              capacityGiB: { type: "number", exclusiveMinimum: 0 },
              readBandwidthGbps: { type: "number", minimum: 0 },
              writeBandwidthGbps: { type: "number", minimum: 0 },
              endpointNodeIds: { type: "array", uniqueItems: true, items: { type: "string" } }
            }
          }
        }
      }
    }
  }
} as const;

export const environmentSnapshotSchema = {
  $id: "https://infraenv.dev/schema/environment-snapshot-v1alpha1.json",
  type: "object",
  required: ["apiVersion", "kind", "metadata", "checksum", "document", "graph", "boot", "performance"],
  properties: {
    apiVersion: { const: "infraenv.io/v1alpha1" }, kind: { const: "EnvironmentSnapshot" },
    metadata: { type: "object" }, checksum: { type: "string", pattern: "^sha256-[a-f0-9]{64}$" },
    document: environmentSchema, graph: { type: "object" }, boot: { type: "object" }, performance: { type: "object" }
  }
} as const;

export const environmentInstanceSchema = {
  $id: "https://infraenv.dev/schema/environment-instance-v1alpha1.json",
  type: "object",
  required: ["apiVersion", "kind", "metadata", "state", "activeNodeId", "boot"],
  properties: {
    apiVersion: { const: "infraenv.io/v1alpha1" }, kind: { const: "EnvironmentInstance" }, metadata: { type: "object" },
    state: { enum: ["provisioning", "booting", "self-testing", "ready", "paused", "draining", "reconciling", "stopping", "stopped", "failed"] },
    activeNodeId: { type: "string" }, runtime: { type: "object" }, boot: { type: "object" }, error: { type: "string" }
  }
} as const;

export interface ValidationFailure {
  valid: false;
  errors: ErrorObject[];
}

export interface ValidationSuccess<T> {
  valid: true;
  value: T;
}

export type SchemaResult<T> = ValidationSuccess<T> | ValidationFailure;

interface AjvLike { compile<T>(schema: unknown): ValidateFunction<T> }
const AjvConstructor = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as unknown as new (options: Record<string, unknown>) => AjvLike;
const ajv = new AjvConstructor({ allErrors: true, strict: true });
const validateScenario = ajv.compile(scenarioSchema) as ValidateFunction<ScenarioDefinition>;
const validateManifest = ajv.compile(manifestSchema) as ValidateFunction<ContentManifest>;
const validateLab = ajv.compile(labSchema) as ValidateFunction<LabDefinition>;
const validateEnvironment = ajv.compile(environmentSchema) as ValidateFunction<EnvironmentDocument>;
const validateEnvironmentSnapshot = ajv.compile(environmentSnapshotSchema) as ValidateFunction<EnvironmentSnapshot>;
const validateEnvironmentInstance = ajv.compile(environmentInstanceSchema) as ValidateFunction<EnvironmentInstance>;

function result<T>(validator: ValidateFunction<T>, value: unknown): SchemaResult<T> {
  if (validator(value)) return { valid: true, value };
  return { valid: false, errors: validator.errors ? [...validator.errors] : [] };
}

export function checkScenario(value: unknown): SchemaResult<ScenarioDefinition> {
  return result(validateScenario, value);
}

export function checkManifest(value: unknown): SchemaResult<ContentManifest> {
  return result(validateManifest, value);
}

export function checkLab(value: unknown): SchemaResult<LabDefinition> {
  return result(validateLab, value);
}

export function checkEnvironment(value: unknown): SchemaResult<EnvironmentDocument> {
  const checked = result(validateEnvironment, value);
  if (!checked.valid) return checked;
  const expandedAccelerators = checked.value.spec.nodes.reduce(
    (total, node) => total + (node.count ?? 1) * node.accelerators.reduce((nodeTotal, accelerator) => nodeTotal + accelerator.count, 0),
    0
  );
  if (expandedAccelerators <= MAX_PLAYGROUND_LOGICAL_GPUS) return checked;
  return {
    valid: false,
    errors: [{
      instancePath: "/spec/nodes",
      schemaPath: "#/properties/spec/maximumExpandedAccelerators",
      keyword: "maximumExpandedAccelerators",
      params: { limit: MAX_PLAYGROUND_LOGICAL_GPUS, actual: expandedAccelerators },
      message: `must expand to at most ${MAX_PLAYGROUND_LOGICAL_GPUS} logical accelerators`
    } satisfies ErrorObject]
  };
}

export function checkEnvironmentSnapshot(value: unknown): SchemaResult<EnvironmentSnapshot> {
  return result(validateEnvironmentSnapshot, value);
}

export function checkEnvironmentInstance(value: unknown): SchemaResult<EnvironmentInstance> {
  return result(validateEnvironmentInstance, value);
}

export interface ExecuteCommandRequest { command: string }
export interface SubmitLabRequest { rootCause?: string; target?: string }
export interface InjectFaultRequest { faultId: string }
export interface ApiError { error: string; message: string; details?: unknown }
export interface CreateEnvironmentRequest { document: EnvironmentDocument }
export interface UpdateEnvironmentRequest { document: EnvironmentDocument; expectedUpdatedAt?: string }
export interface CreateSnapshotRequest { label?: string }
export interface StartInstanceRequest { snapshotId?: string; nodeId?: string; docker?: boolean }
export interface CreateCheckpointRequest { instanceId?: string; label?: string; payload?: Record<string, unknown> }
