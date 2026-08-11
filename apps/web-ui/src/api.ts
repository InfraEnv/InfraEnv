import type {
  ApiCollection,
  BootstrapData,
  EnvironmentDraft,
  EnvironmentSummary,
  InstanceDetail,
  InstanceSummary,
  PresetSummary,
  SupervisorStatus,
  TerminalTicket,
  TrashedEnvironment
} from "./types.js";

const ROOT = "/api/v1";

export class SupervisorApiError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = "SupervisorApiError";
  }

  get unavailable(): boolean {
    return this.status === undefined || this.status === 404 || this.status === 502 || this.status === 503;
  }
}

let csrfToken = "";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${ROOT}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(csrfToken && init.method && init.method !== "GET" ? { "x-infraenv-csrf": csrfToken } : {}),
        ...init.headers
      }
    });
  } catch {
    throw new SupervisorApiError("无法连接本机 InfraEnv Supervisor。请先运行 `infraenv webui`。", undefined, "network_unavailable");
  }

  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json") ? await response.json() as unknown : await response.text();
  if (!response.ok) {
    const problem = body && typeof body === "object" ? body as { message?: string; error?: string } : undefined;
    throw new SupervisorApiError(problem?.message ?? `Supervisor 请求失败（HTTP ${response.status}）。`, response.status, problem?.error);
  }
  return body as unknown as T;
}

function items<T>(value: ApiCollection<T> | T[]): T[] {
  return Array.isArray(value) ? value : value.items;
}

export async function bootstrapSupervisor(): Promise<BootstrapData> {
  const status = await request<SupervisorStatus>("/status");
  csrfToken = status.csrfToken ?? "";
  const [environmentResponse, presetResponse, instanceResponse, trashResponse] = await Promise.all([
    request<ApiCollection<EnvironmentSummary> | EnvironmentSummary[]>("/environments"),
    request<ApiCollection<PresetSummary> | PresetSummary[]>("/presets"),
    request<ApiCollection<InstanceSummary> | InstanceSummary[]>("/instances"),
    status.capabilities?.includes("environment.trash")
      ? request<ApiCollection<TrashedEnvironment> | TrashedEnvironment[]>("/environments/trash")
      : Promise.resolve({ items: [] } satisfies ApiCollection<TrashedEnvironment>)
  ]);
  return {
    status,
    environments: items(environmentResponse),
    presets: items(presetResponse),
    instances: items(instanceResponse),
    trash: items(trashResponse)
  };
}

export async function exchangeLaunchToken(): Promise<"supervisor" | "direct-runtime" | undefined> {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const launchToken = fragment.get("launchToken");
  if (!launchToken) return undefined;

  const exchange = async (path: string): Promise<Response> => fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ launchToken })
  });

  let mode: "supervisor" | "direct-runtime" | undefined;
  try {
    const supervisor = await exchange(`${ROOT}/auth/exchange`);
    if (supervisor.ok) mode = "supervisor";
    else if (supervisor.status === 404) {
      const direct = await exchange("/v1/auth/exchange");
      if (direct.ok) mode = "direct-runtime";
    }
  } catch {
    try {
      const direct = await exchange("/v1/auth/exchange");
      if (direct.ok) mode = "direct-runtime";
    } catch {
      // The connection state shown by App is more useful than failing boot here.
    }
  }
  window.history.replaceState({}, "", `${window.location.pathname}${window.location.search}#/environments`);
  return mode;
}

export async function createEnvironment(draft: EnvironmentDraft): Promise<EnvironmentSummary> {
  return request("/environments", { method: "POST", body: JSON.stringify(draft) });
}

export async function updateEnvironment(id: string, draft: EnvironmentDraft): Promise<EnvironmentSummary> {
  return request(`/environments/${encodeURIComponent(id)}`, {
    method: "PATCH",
    ...(draft.revision ? { headers: { "if-match": String(draft.revision) } } : {}),
    body: JSON.stringify(draft)
  });
}

export async function getEnvironment(id: string): Promise<EnvironmentDraft> {
  return request(`/environments/${encodeURIComponent(id)}`);
}

export async function deleteEnvironment(id: string): Promise<void> {
  await request(`/environments/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function cloneEnvironment(id: string, name: string): Promise<EnvironmentSummary> {
  return request(`/environments/${encodeURIComponent(id)}/clone`, { method: "POST", body: JSON.stringify({ name }) });
}

export async function restoreEnvironment(id: string): Promise<EnvironmentSummary> {
  return request(`/environments/trash/${encodeURIComponent(id)}/restore`, { method: "POST", body: "{}" });
}

export async function purgeEnvironment(id: string): Promise<void> {
  await request(`/environments/trash/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function importEnvironment(file: File): Promise<EnvironmentSummary> {
  if (file.size > 1024 * 1024) throw new SupervisorApiError("Environment 导入文件不得超过 1 MiB。", 422, "import_too_large");
  const source = await file.text();
  let bundle: unknown;
  try {
    bundle = JSON.parse(source);
  } catch {
    throw new SupervisorApiError("当前 Alpha 只接受 JSON Environment export；YAML 导入尚未启用。", 422, "import_json_required");
  }
  return request("/environments/import", { method: "POST", body: JSON.stringify(bundle) });
}

export async function exportEnvironment(id: string): Promise<void> {
  const definition = await request<unknown>(`/environments/${encodeURIComponent(id)}/export`);
  const blob = new Blob([`${JSON.stringify(definition, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${id.replace(/[^a-z0-9-]/gi, "-")}.infraenv.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function startEnvironment(id: string): Promise<InstanceSummary> {
  return request(`/environments/${encodeURIComponent(id)}/start`, { method: "POST", body: "{}" });
}

export async function controlInstance(id: string, action: "stop" | "restart" | "reset" | "pause" | "resume" | "reconcile"): Promise<InstanceSummary> {
  return request(`/instances/${encodeURIComponent(id)}/${action}`, { method: "POST", body: "{}" });
}

export async function createCheckpoint(instanceId: string, name: string): Promise<InstanceDetail> {
  return request(`/instances/${encodeURIComponent(instanceId)}/checkpoints`, { method: "POST", body: JSON.stringify({ name }) });
}

export async function restoreCheckpoint(instanceId: string, checkpointId: string): Promise<InstanceDetail> {
  return request(`/instances/${encodeURIComponent(instanceId)}/checkpoints/${encodeURIComponent(checkpointId)}/restore`, { method: "POST", body: "{}" });
}

export async function startSymbolicLoad(instanceId: string, objectKey: string, sizeBytes?: number): Promise<InstanceDetail> {
  return request(`/instances/${encodeURIComponent(instanceId)}/storage/loads`, { method: "POST", body: JSON.stringify({ objectKey, ...(sizeBytes ? { sizeBytes } : {}) }) });
}

export async function connectStorage(instanceId: string): Promise<InstanceDetail> {
  return request(`/instances/${encodeURIComponent(instanceId)}/storage/connect`, { method: "POST", body: "{}" });
}

export async function getInstance(id: string): Promise<InstanceDetail> {
  return request(`/instances/${encodeURIComponent(id)}`);
}

export async function injectFault(instanceId: string, faultId: string, target?: string): Promise<InstanceDetail> {
  return request(`/instances/${encodeURIComponent(instanceId)}/faults`, {
    method: "POST",
    body: JSON.stringify({ faultId, ...(target ? { target } : {}) })
  });
}

export async function clearFault(instanceId: string, faultId: string): Promise<InstanceDetail> {
  return request(`/instances/${encodeURIComponent(instanceId)}/faults/${encodeURIComponent(faultId)}`, { method: "DELETE" });
}

export async function createTerminalTicket(instanceId: string): Promise<TerminalTicket> {
  return request(`/instances/${encodeURIComponent(instanceId)}/terminal-ticket`, { method: "POST", body: "{}" });
}

async function directRuntimeRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "include",
      headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers }
    });
  } catch {
    throw new SupervisorApiError("无法连接课程 Runtime。", undefined, "runtime_offline");
  }
  const body = await response.json().catch(() => undefined) as { message?: string; error?: string } | undefined;
  if (!response.ok) throw new SupervisorApiError(body?.message ?? `课程 Runtime 请求失败（HTTP ${response.status}）。`, response.status, body?.error);
  return body as T;
}

export async function getDirectRuntimeState<T>(): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/v1/session/state", { credentials: "include", headers: { accept: "application/json" } });
  } catch {
    throw new SupervisorApiError("本机 Supervisor 与 Runtime 均未连接。", undefined, "offline");
  }
  if (!response.ok) throw new SupervisorApiError("本机 Supervisor 未运行。", response.status, "supervisor_unavailable");
  return response.json() as Promise<T>;
}

export async function directRuntimeControl<T>(action: "pause" | "resume" | "reset"): Promise<T> {
  const response = await fetch(`/v1/control/${action}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  if (!response.ok) throw new SupervisorApiError(`Runtime ${action} 操作失败。`, response.status);
  return response.json() as Promise<T>;
}

export async function directRuntimeInjectFault<T>(faultId: string): Promise<T> {
  return directRuntimeRequest<T>("/v1/faults/inject", { method: "POST", body: JSON.stringify({ faultId }) });
}

export async function directRuntimeClearFault<T>(faultId: string): Promise<T> {
  return directRuntimeRequest<T>(`/v1/faults/${encodeURIComponent(faultId)}/clear`, { method: "POST", body: "{}" });
}

export function terminalWebSocket(ticket: TerminalTicket): WebSocket {
  const url = new URL(ticket.websocketUrl, window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(url, ticket.subprotocol);
}
