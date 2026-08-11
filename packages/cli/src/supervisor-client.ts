import { loadSupervisorState } from "./supervisor-state.js";

export interface SupervisorConnection {
  apiUrl: string;
  token?: string;
}

export interface SupervisorApiErrorBody {
  error?: string;
  message?: string;
  details?: unknown;
}

export class SupervisorApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(message: string, status: number, body?: SupervisorApiErrorBody) {
    super(message);
    this.name = "SupervisorApiError";
    this.status = status;
    if (body?.error !== undefined) this.code = body.error;
    if (body?.details !== undefined) this.details = body.details;
  }
}

function normalizeApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`Invalid INFRAENV_SUPERVISOR_URL: ${value}`, { cause: error });
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1" || url.hostname === "[::1]";
  if (url.protocol !== "http:" || !loopback || url.username.length > 0 || url.password.length > 0) {
    throw new Error("The v0.2 Supervisor URL must be credential-free HTTP on 127.0.0.1, localhost, or ::1.");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!url.pathname.endsWith("/api/v1")) url.pathname = `${url.pathname}/api/v1`.replace(/\/{2,}/g, "/");
  return url.toString().replace(/\/$/, "");
}

export async function resolveSupervisorConnection(): Promise<SupervisorConnection> {
  const state = await loadSupervisorState(true);
  const apiUrl = normalizeApiUrl(process.env.INFRAENV_SUPERVISOR_URL ?? state?.apiUrl ?? "http://127.0.0.1:9090/api/v1");
  const token = process.env.INFRAENV_SUPERVISOR_TOKEN?.trim() || undefined;
  return token === undefined ? { apiUrl } : { apiUrl, token };
}

export class SupervisorClient {
  constructor(readonly connection: SupervisorConnection) {}

  async request<T>(path: string, init: RequestInit = {}, authenticated = true): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
    if (authenticated && this.connection.token !== undefined) headers.set("authorization", `Bearer ${this.connection.token}`);

    let response: Response;
    try {
      response = await fetch(`${this.connection.apiUrl}${path}`, { ...init, headers });
    } catch (error) {
      throw new Error(
        `Cannot reach the InfraEnv Supervisor at ${this.connection.apiUrl}. ` +
        "Run `infraenv supervisor serve`, or check INFRAENV_SUPERVISOR_URL.",
        { cause: error }
      );
    }

    const text = await response.text();
    let body: unknown;
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }

    if (!response.ok) {
      const errorBody = typeof body === "object" && body !== null ? body as SupervisorApiErrorBody : undefined;
      let message = errorBody?.message ?? (typeof body === "string" ? body : `Supervisor request failed with HTTP ${response.status}.`);
      if (response.status === 401 || response.status === 403) {
        message += " Set INFRAENV_SUPERVISOR_TOKEN to the process-local token printed by `infraenv supervisor serve`.";
      } else if (response.status === 404) {
        message += " This Supervisor may not expose that v0.2 capability; inspect `infraenv supervisor capabilities`.";
      }
      throw new SupervisorApiError(message, response.status, errorBody);
    }
    return body as T;
  }

  get<T>(path: string, authenticated = true): Promise<T> {
    return this.request<T>(path, {}, authenticated);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "POST", body: JSON.stringify(body) });
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "PUT", body: JSON.stringify(body) });
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "DELETE" });
  }
}

export async function supervisorClient(): Promise<SupervisorClient> {
  return new SupervisorClient(await resolveSupervisorConnection());
}

export function apiSegment(value: string): string {
  return encodeURIComponent(value);
}
