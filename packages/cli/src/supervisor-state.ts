import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface SupervisorState {
  apiUrl: string;
  dataDir?: string;
  pid?: number;
  startedAt?: string;
  activeEnvironmentId?: string;
  activeInstanceId?: string;
  activeNodeId?: string;
}

export function supervisorStateFilePath(): string {
  return process.env.INFRAENV_SUPERVISOR_STATE_FILE ?? join(homedir(), ".infraenv", "supervisor.json");
}

export function defaultSupervisorDataDir(): string {
  return process.env.INFRAENV_SUPERVISOR_DATA_DIR ?? join(homedir(), ".infraenv", "supervisor-data");
}

export async function loadSupervisorState(optional = false): Promise<SupervisorState | undefined> {
  try {
    const value = JSON.parse(await readFile(supervisorStateFilePath(), "utf8")) as unknown;
    if (typeof value !== "object" || value === null || typeof (value as { apiUrl?: unknown }).apiUrl !== "string") {
      throw new Error("Supervisor state is not a valid non-secret state document.");
    }
    const record = value as Record<string, unknown>;
    return {
      apiUrl: record.apiUrl as string,
      ...(typeof record.dataDir === "string" ? { dataDir: record.dataDir } : {}),
      ...(typeof record.pid === "number" ? { pid: record.pid } : {}),
      ...(typeof record.startedAt === "string" ? { startedAt: record.startedAt } : {}),
      ...(typeof record.activeEnvironmentId === "string" ? { activeEnvironmentId: record.activeEnvironmentId } : {}),
      ...(typeof record.activeInstanceId === "string" ? { activeInstanceId: record.activeInstanceId } : {}),
      ...(typeof record.activeNodeId === "string" ? { activeNodeId: record.activeNodeId } : {})
    };
  } catch (error) {
    if (optional) return undefined;
    throw new Error(
      `No local Supervisor state was found at ${supervisorStateFilePath()}. ` +
      "Start it with `infraenv supervisor serve`, or set INFRAENV_SUPERVISOR_URL and INFRAENV_SUPERVISOR_TOKEN.",
      { cause: error }
    );
  }
}

export async function saveSupervisorState(state: SupervisorState): Promise<void> {
  const path = supervisorStateFilePath();
  const safeState: SupervisorState = {
    apiUrl: state.apiUrl,
    ...(state.dataDir === undefined ? {} : { dataDir: state.dataDir }),
    ...(state.pid === undefined ? {} : { pid: state.pid }),
    ...(state.startedAt === undefined ? {} : { startedAt: state.startedAt }),
    ...(state.activeEnvironmentId === undefined ? {} : { activeEnvironmentId: state.activeEnvironmentId }),
    ...(state.activeInstanceId === undefined ? {} : { activeInstanceId: state.activeInstanceId }),
    ...(state.activeNodeId === undefined ? {} : { activeNodeId: state.activeNodeId })
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(safeState, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
}

export async function updateSupervisorContext(instanceId: string, nodeId: string): Promise<SupervisorState> {
  const previous = await loadSupervisorState(true);
  const next: SupervisorState = {
    apiUrl: previous?.apiUrl ?? process.env.INFRAENV_SUPERVISOR_URL ?? "http://127.0.0.1:9090/api/v1",
    ...(previous?.dataDir === undefined ? {} : { dataDir: previous.dataDir }),
    ...(previous?.pid === undefined ? {} : { pid: previous.pid }),
    ...(previous?.startedAt === undefined ? {} : { startedAt: previous.startedAt }),
    ...(previous?.activeEnvironmentId === undefined ? {} : { activeEnvironmentId: previous.activeEnvironmentId }),
    activeInstanceId: instanceId,
    activeNodeId: nodeId
  };
  await saveSupervisorState(next);
  return next;
}

export async function updateSupervisorEnvironmentContext(environmentId: string, instanceId?: string, nodeId?: string): Promise<SupervisorState> {
  const previous = await loadSupervisorState(true);
  const next: SupervisorState = {
    apiUrl: previous?.apiUrl ?? process.env.INFRAENV_SUPERVISOR_URL ?? "http://127.0.0.1:9090/api/v1",
    ...(previous?.dataDir === undefined ? {} : { dataDir: previous.dataDir }),
    ...(previous?.pid === undefined ? {} : { pid: previous.pid }),
    ...(previous?.startedAt === undefined ? {} : { startedAt: previous.startedAt }),
    activeEnvironmentId: environmentId,
    ...(instanceId === undefined ? {} : { activeInstanceId: instanceId }),
    ...(nodeId === undefined ? {} : { activeNodeId: nodeId })
  };
  await saveSupervisorState(next);
  return next;
}
