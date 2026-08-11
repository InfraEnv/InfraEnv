import { access } from "node:fs/promises";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { SubmitLabRequest } from "@infraenv/protocol";
import {
  RUNTIME_VERSION,
  type RuntimeEvent,
  type SessionTokens,
  type SimulationSnapshot,
  type ValidationResult
} from "@infraenv/shared";
import { CommandSimulator, SimulationEngine, findSlowWorkerLab, runtimeCurriculumProfile } from "@infraenv/simulation";
import { validateLab } from "@infraenv/validator";
import { createSessionTokens, randomToken, secureEqual } from "./auth.js";
import { ProgressStore } from "./progress-store.js";

export interface RuntimeOptions {
  tokens?: SessionTokens;
  progressFile?: string;
  curriculumChecksum?: string;
  staticRoot?: string;
  logger?: boolean;
  sessionId?: string;
}

export interface RuntimeContext {
  engine: SimulationEngine;
  simulator: CommandSimulator;
  tokens: SessionTokens;
  events: RuntimeEvent[];
  curriculumChecksum: string;
  progress: ProgressStore;
}

export interface RuntimeApplication {
  app: FastifyInstance;
  context: RuntimeContext;
}

type AuthRole = "host" | "sandbox" | "ui";

function bearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}

export async function createRuntime(options: RuntimeOptions = {}): Promise<RuntimeApplication> {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 32 * 1024 });
  const tokens = options.tokens ?? createSessionTokens();
  const engine = new SimulationEngine(undefined, options.sessionId ? { sessionId: options.sessionId } : {});
  const simulator = new CommandSimulator(engine);
  const curriculumChecksum = options.curriculumChecksum ?? "sha256-builtin-find-slow-worker-v1";
  const progress = new ProgressStore({
    filePath: options.progressFile ?? join(process.cwd(), ".infraenv", "progress", `${engine.sessionId}.jsonl`),
    sessionId: engine.sessionId,
    scenarioId: engine.scenario.id,
    scenarioVersion: engine.scenario.version,
    curriculumChecksum,
    contentVersion: runtimeCurriculumProfile.manifest.contentVersion
  });
  const events: RuntimeEvent[] = [];
  const sockets = new Set<{ send(payload: string): void; readyState: number }>();
  const uiSessionToken = randomToken();
  let launchTokenConsumed = false;

  const context: RuntimeContext = { engine, simulator, tokens, events, curriculumChecksum, progress };

  const publish = (type: RuntimeEvent["type"], data: unknown): void => {
    const event: RuntimeEvent = { type, at: new Date().toISOString(), data };
    events.push(event);
    if (events.length > 200) events.shift();
    const encoded = JSON.stringify(event);
    for (const socket of sockets) if (socket.readyState === 1) socket.send(encoded);
  };

  const roleFor = (request: FastifyRequest): AuthRole | undefined => {
    const token = bearer(request);
    if (secureEqual(token, tokens.hostToken)) return "host";
    if (secureEqual(token, tokens.sandboxToken)) return "sandbox";
    if (secureEqual(request.cookies.infraenv_session, uiSessionToken)) return "ui";
    return undefined;
  };

  await app.register(cookie);
  await app.register(websocket);

  app.get("/healthz", async () => ({ ok: true, runtimeVersion: RUNTIME_VERSION }));

  app.post<{ Body: { launchToken?: string } }>("/v1/auth/exchange", async (request, reply) => {
    if (launchTokenConsumed || !secureEqual(request.body?.launchToken, tokens.uiLaunchToken)) {
      return reply.code(401).send({ error: "invalid_launch_token", message: "The one-time UI launch token is invalid or already used." });
    }
    launchTokenConsumed = true;
    reply.setCookie("infraenv_session", uiSessionToken, { path: "/", httpOnly: true, sameSite: "strict", secure: false, maxAge: 60 * 60 * 8 });
    return { ok: true };
  });

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/v1/") || request.url.startsWith("/v1/auth/exchange")) return;
    const role = roleFor(request);
    if (!role) return reply.code(401).send({ error: "unauthorized", message: "A valid session credential is required." });
    if (role === "host" || request.method === "GET") return;
    const path = request.url.split("?")[0] ?? request.url;
    const action = path === "/v1/control/pause" ? "pause" : path === "/v1/control/resume" ? "resume" : path === "/v1/control/reset" ? "reset" : path === "/v1/faults/inject" ? "inject-listed-fault" : /^\/v1\/faults\/[^/]+\/clear$/.test(path) ? "clear-listed-fault" : undefined;
    const uiControl = role === "ui" && Boolean(action && findSlowWorkerLab.allowedUiActions.includes(action));
    const sandboxCommand = role === "sandbox" && path === "/v1/commands/execute";
    if (uiControl || sandboxCommand) return;
    return reply.code(403).send({ error: "forbidden", message: `${role} credentials cannot perform this operation.` });
  });

  app.get("/v1/session/state", async () => engine.snapshot());
  app.get("/v1/nodes", async () => ({ disclosure: engine.snapshot().disclosure, nodes: engine.snapshot().nodes }));
  app.get("/v1/jobs", async () => ({ disclosure: engine.snapshot().disclosure, jobs: [engine.snapshot().job], training: engine.snapshot().training }));
  app.get<{ Querystring: { group?: string } }>("/v1/metrics", async (request) => {
    const state = engine.snapshot();
    if (request.query.group === "network") return { disclosure: state.disclosure, network: state.nodes.map(({ id, network }) => ({ id, ...network })) };
    if (request.query.group === "gpu") return { disclosure: state.disclosure, gpu: state.nodes.map(({ id, gpus, communicationWaitMs }) => ({ id, gpus, communicationWaitMs })) };
    return { disclosure: state.disclosure, training: state.training };
  });

  app.post<{ Body: { command?: string } }>("/v1/commands/execute", async (request, reply) => {
    const command = request.body?.command?.trim();
    if (!command || command.length > 500 || /[\r\n\0]/.test(command)) {
      return reply.code(400).send({ error: "invalid_command", message: "Command must be a single line of at most 500 characters." });
    }
    if (roleFor(request) === "sandbox" && !isSandboxCommandAllowed(command)) {
      return reply.code(403).send({ error: "sandbox_command_forbidden", message: "The sandbox token permits only the scenario command whitelist." });
    }
    if (command.startsWith("infraenv fault clear ")) {
      const faultId = command.split(/\s+/)[3] ?? "";
      try {
        engine.observeCommand(command);
        const state = engine.clearFault(faultId);
        await progress.append("fault.cleared", { faultId });
        publish("state", state);
        return { command, stdout: `${state.disclosure}\nCleared ${faultId}. Metrics have recovered.`, stderr: "", exitCode: 0, revision: state.revision };
      } catch (error) {
        return reply.code(400).send({ error: "fault_not_allowed", message: error instanceof Error ? error.message : "Fault is not allowed." });
      }
    }
    if (command.startsWith("infraenv lab submit")) {
      const rootCause = /--root-cause\s+(\S+)/.exec(command)?.[1];
      const target = /--target\s+(\S+)/.exec(command)?.[1];
      if (rootCause && target) engine.setHypothesis(rootCause, target);
      engine.observeCommand(command);
      const validation = validateLab(findSlowWorkerLab, engine.snapshot());
      if (validation.passed) engine.markPassed();
      await progress.append("lab.submitted", { rootCause, target, validation });
      publish("validation", validation);
      return { command, stdout: renderValidation(validation), stderr: "", exitCode: validation.passed ? 0 : 3, revision: engine.snapshot().revision };
    }
    const result = simulator.execute(command);
    await progress.append("command.executed", { command, exitCode: result.exitCode });
    publish("command", result);
    return result;
  });

  app.post("/v1/control/pause", async () => { const state = publishState(engine.pause(), publish); await progress.append("control.changed", { action: "pause" }); return state; });
  app.post("/v1/control/resume", async () => { const state = publishState(engine.resume(), publish); await progress.append("control.changed", { action: "resume" }); return state; });
  app.post("/v1/control/reset", async () => { const state = publishState(engine.reset(), publish); await progress.append("control.changed", { action: "reset" }); return state; });

  app.post<{ Body: { faultId?: string } }>("/v1/faults/inject", async (request, reply) => {
    try {
      const state = engine.injectFault(request.body?.faultId ?? "");
      await progress.append("fault.injected", { faultId: request.body?.faultId });
      publish("state", state);
      return state;
    } catch (error) {
      return reply.code(400).send({ error: "fault_not_allowed", message: error instanceof Error ? error.message : "Fault is not allowed." });
    }
  });

  app.post<{ Params: { id: string } }>("/v1/faults/:id/clear", async (request, reply) => {
    const faultId = decodeURIComponent(request.params.id);
    try {
      const state = engine.clearFault(faultId);
      await progress.append("fault.cleared", { faultId });
      publish("state", state);
      return state;
    } catch (error) {
      return reply.code(404).send({ error: "unknown_fault", message: error instanceof Error ? error.message : "Unknown fault." });
    }
  });

  app.post<{ Body: SubmitLabRequest }>("/v1/labs/submit", async (request) => {
    if (request.body?.rootCause && request.body.target) engine.setHypothesis(request.body.rootCause, request.body.target);
    const validation = validateLab(findSlowWorkerLab, engine.snapshot());
    if (validation.passed) engine.markPassed();
    await progress.append("lab.submitted", { ...request.body, validation });
    publish("validation", validation);
    return validation;
  });

  app.get("/v1/events", { websocket: true }, (socket, request) => {
    if (!roleFor(request)) {
      socket.close(1008, "unauthorized");
      return;
    }
    sockets.add(socket);
    socket.send(JSON.stringify({ type: "state", at: new Date().toISOString(), data: engine.snapshot() } satisfies RuntimeEvent));
    socket.on("close", () => sockets.delete(socket));
  });

  if (options.staticRoot) {
    try {
      await access(options.staticRoot);
      await app.register(fastifyStatic, { root: options.staticRoot, prefix: "/app/", wildcard: false });
      app.get("/app/*", async (_request, reply) => reply.sendFile("index.html"));
      app.get("/", async (_request, reply) => reply.redirect("/app/"));
    } catch {
      app.get("/", async () => ({ name: "InfraEnv Runtime", disclosure: engine.snapshot().disclosure, ui: "not-built" }));
    }
  } else {
    app.get("/", async () => ({ name: "InfraEnv Runtime", disclosure: engine.snapshot().disclosure, ui: "not-configured" }));
  }

  await progress.append("session.started", { contentVersion: runtimeCurriculumProfile.manifest.contentVersion, simulationLevel: "S2" });
  return { app, context };
}

function publishState(snapshot: SimulationSnapshot, publish: (type: RuntimeEvent["type"], data: unknown) => void): SimulationSnapshot {
  publish("state", snapshot);
  return snapshot;
}

function renderValidation(result: ValidationResult): string {
  const checks = result.checks.map((check) => `${check.passed ? "PASS" : "MISS"}  ${check.label} — ${check.detail}`).join("\n");
  return `SIMULATED / S2 LAB VALIDATION\n${checks}\n\n${result.summary}`;
}

function isSandboxCommandAllowed(command: string): boolean {
  const excludedHostCommands = /^(?:infraenv doctor|infraenv lab list|infraenv lab start\b)/;
  const whitelist = new Set(
    findSlowWorkerLab.steps
      .flatMap((step) => step.command?.split("&&") ?? [])
      .map((item) => item.trim())
      .filter((item) => item && !excludedHostCommands.test(item))
  );
  return whitelist.has(command);
}
