import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface LocalSession {
  sessionId: string;
  runtimeContainer: string;
  sandboxContainer: string;
  network: string;
  hostNetwork: string;
  progressVolume: string;
  apiUrl: string;
  hostToken: string;
  uiLaunchToken: string;
  startedAt: string;
}

export function stateFilePath(): string {
  return process.env.INFRAENV_STATE_FILE ?? join(homedir(), ".infraenv", "session.json");
}

export async function saveSession(session: LocalSession): Promise<void> {
  const path = stateFilePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(session, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
}

export async function loadSession(): Promise<LocalSession> {
  try {
    return JSON.parse(await readFile(stateFilePath(), "utf8")) as LocalSession;
  } catch {
    throw new Error("No active InfraEnv session. Start one with `infraenv lab start find-slow-worker`.");
  }
}

export async function markStopped(session: LocalSession): Promise<void> {
  await saveSession({ ...session, apiUrl: "stopped" });
}
