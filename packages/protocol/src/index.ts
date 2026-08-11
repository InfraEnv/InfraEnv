import AjvModule, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type { ContentManifest, LabDefinition, ScenarioDefinition } from "@infraenv/shared";

export const namespaceIdPattern = "^(course|chapter|lesson|lab|scenario|topic|concept|tool):[a-z0-9]+(?:-[a-z0-9]+)*$";

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
        disclosure: { type: "string", minLength: 1 }
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

export interface ExecuteCommandRequest { command: string }
export interface SubmitLabRequest { rootCause?: string; target?: string }
export interface InjectFaultRequest { faultId: string }
export interface ApiError { error: string; message: string; details?: unknown }
