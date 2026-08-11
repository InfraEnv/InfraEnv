import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createRuntime } from "@infraenv/runtime";
import { runtimeCurriculumProfile } from "@infraenv/simulation";

describe("local runtime API", () => {
  it("requires auth, executes commands, enforces one-time UI exchange and validates recovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "infraenv-runtime-"));
    const progressFile = join(directory, "progress.jsonl");
    const tokens = { hostToken: "host-test-token", sandboxToken: "sandbox-test-token", uiLaunchToken: "ui-test-token" };
    const { app } = await createRuntime({ tokens, progressFile, sessionId: "session-test" });
    const auth = { authorization: `Bearer ${tokens.hostToken}` };

    expect((await app.inject({ method: "GET", url: "/v1/session/state" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: `/v1/session/state?token=${tokens.hostToken}` })).statusCode).toBe(401);
    const state = await app.inject({ method: "GET", url: "/v1/session/state", headers: auth });
    expect(state.statusCode).toBe(200);
    expect(state.json().nodes).toHaveLength(16);

    const exchange = await app.inject({ method: "POST", url: "/v1/auth/exchange", payload: { launchToken: tokens.uiLaunchToken } });
    expect(exchange.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/v1/auth/exchange", payload: { launchToken: tokens.uiLaunchToken } })).statusCode).toBe(401);
    const uiCookie = (exchange.headers["set-cookie"] as string).split(";")[0] ?? "";
    expect((await app.inject({ method: "GET", url: "/v1/session/state", headers: { cookie: uiCookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/v1/control/pause", headers: { cookie: uiCookie }, payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/v1/commands/execute", headers: { cookie: uiCookie }, payload: { command: "infraenv nodes" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/v1/labs/submit", headers: { cookie: uiCookie }, payload: {} })).statusCode).toBe(403);
    await app.inject({ method: "POST", url: "/v1/control/resume", headers: auth, payload: {} });

    const sandboxAuth = { authorization: `Bearer ${tokens.sandboxToken}` };
    for (const command of ["infraenv nodes", "infraenv metrics network", "infraenv metrics gpu", "infraenv inspect node03", "infraenv lab submit --root-cause network.bandwidth_drop --target node03", "infraenv fault clear fault:node03-bandwidth", "infraenv lab submit"]) {
      const response = await app.inject({ method: "POST", url: "/v1/commands/execute", headers: sandboxAuth, payload: { command } });
      expect(response.statusCode).toBe(200);
      if (command === "infraenv lab submit") expect(response.json().exitCode).toBe(0);
    }
    expect((await app.inject({ method: "POST", url: "/v1/commands/execute", headers: sandboxAuth, payload: { command: "infraenv fault clear fault:another" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/v1/faults/inject", headers: sandboxAuth, payload: { faultId: "fault:node03-bandwidth" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/v1/labs/submit", headers: sandboxAuth, payload: {} })).statusCode).toBe(403);

    const final = await app.inject({ method: "POST", url: "/v1/labs/submit", headers: auth, payload: {} });
    expect(final.json().passed).toBe(true);
    await app.close();
    const records = (await readFile(progressFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { sessionId: string; contentVersion: string });
    expect(records.every((record) => record.sessionId === "session-test")).toBe(true);
    expect(records.every((record) => record.contentVersion === runtimeCurriculumProfile.manifest.contentVersion)).toBe(true);
  });
});
