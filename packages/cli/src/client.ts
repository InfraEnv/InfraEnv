import type { LocalSession } from "./session-file.js";

export async function apiRequest<T>(session: LocalSession, path: string, init: RequestInit = {}): Promise<T> {
  if (session.apiUrl === "stopped") throw new Error("The saved session is stopped. Start a new lab session.");
  const response = await fetch(`${session.apiUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${session.hostToken}`,
      "content-type": "application/json",
      ...init.headers
    }
  });
  const body = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(body.message ?? `Runtime request failed with HTTP ${response.status}.`);
  return body;
}

export async function executeRemote(session: LocalSession, command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return apiRequest(session, "/commands/execute", { method: "POST", body: JSON.stringify({ command }) });
}

export async function waitForRuntime(session: LocalSession, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const healthUrl = session.apiUrl.replace(/\/v1$/, "/healthz");
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return;
    } catch {
      // Container startup races are expected; retry within the fixed deadline.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Runtime sidecar did not become healthy within ${timeoutMs}ms.`);
}
