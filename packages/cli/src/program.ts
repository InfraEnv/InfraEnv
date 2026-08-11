import { Command } from "commander";
import { SIMULATION_DISCLOSURE, type SimulationSnapshot, type ValidationResult } from "@infraenv/shared";
import { findSlowWorkerLab } from "@infraenv/simulation";
import { apiRequest, executeRemote, waitForRuntime } from "./client.js";
import { renderDoctor } from "./doctor.js";
import { docker, runSandbox, startDockerSession, stopDockerSession } from "./docker.js";
import { loadSession, markStopped, saveSession } from "./session-file.js";
import { addV2Commands, clearSupervisorFault } from "./v2-commands.js";

export function createProgram(): Command {
  const program = new Command();
  program.name("infraenv").description("Portable AI infrastructure learning and S2 simulation runtime").version("0.2.0-alpha.0");

  program.command("doctor").description("Check the local runtime prerequisites").action(() => {
    const result = renderDoctor();
    console.log(result.text);
    if (!result.ok) process.exitCode = 1;
  });

  const lab = program.command("lab").description("List, start, manage and submit labs");
  lab.command("list").action(() => {
    console.log(`${SIMULATION_DISCLOSURE}\n\nID                LEVEL  GPU REQUIRED  TITLE\n${findSlowWorkerLab.slug.padEnd(17)} S2     no            ${findSlowWorkerLab.title}`);
  });

  lab.command("start <slug>").option("--ui", "print the local Web UI launch URL").description("Start a lab in an isolated Docker network").action(async (slug: string, options: { ui?: boolean }) => {
    if (slug !== findSlowWorkerLab.slug) throw new Error(`Unknown lab ${slug}. Run \`infraenv lab list\`.`);
    const doctor = renderDoctor();
    if (!doctor.ok) throw new Error(`${doctor.text}\n\nCannot start the lab until Docker is ready.`);
    const { session, sandboxToken } = startDockerSession();
    await saveSession(session);
    try {
      await waitForRuntime(session);
    } catch (error) {
      stopDockerSession(session);
      await markStopped(session);
      throw error;
    }
    console.log(`${SIMULATION_DISCLOSURE}\nSession ${session.sessionId} started.\nRuntime API: ${session.apiUrl}`);
    if (options.ui) console.log(`Web UI: ${session.apiUrl.replace(/\/v1$/, "/app/")}#launchToken=${encodeURIComponent(session.uiLaunchToken)}\nThe single-use launch token remains in the URL fragment and is not sent in HTTP requests.`);
    console.log("\nEntering a real Ubuntu Bash sandbox. Cluster, GPU, scheduler and performance state remain simulated S2.\nType `exit` to leave and clean up the containers.\n");
    try {
      await runSandbox(session, sandboxToken);
    } finally {
      stopDockerSession(session);
      await markStopped(session);
    }
  });

  lab.command("status").action(async () => {
    const session = await loadSession();
    if (session.apiUrl === "stopped") {
      console.log(`Session ${session.sessionId} is stopped. Progress volume ${session.progressVolume} is retained locally.`);
      return;
    }
    const state = await apiRequest<SimulationSnapshot>(session, "/session/state");
    console.log(`${state.disclosure}\n${state.sessionId} ${state.status} T+${state.virtualTimeSeconds}s revision=${state.revision}`);
  });

  lab.command("stop").action(async () => {
    const session = await loadSession();
    stopDockerSession(session);
    await markStopped(session);
    console.log(`Stopped ${session.sessionId}. Progress volume ${session.progressVolume} was retained.`);
  });

  lab.command("reset").action(async () => {
    const session = await loadSession();
    const result = await apiRequest<SimulationSnapshot>(session, "/control/reset", { method: "POST", body: "{}" });
    console.log(`${result.disclosure}\nReset ${result.sessionId} to deterministic T+${result.virtualTimeSeconds}s.`);
  });

  lab.command("submit").option("--root-cause <cause>").option("--target <node>").action(async (options: { rootCause?: string; target?: string }) => {
    const session = await loadSession();
    const result = await apiRequest<ValidationResult>(session, "/labs/submit", { method: "POST", body: JSON.stringify(options) });
    console.log(`SIMULATED / S2 LAB VALIDATION\n${result.checks.map((check) => `${check.passed ? "PASS" : "MISS"} ${check.label} — ${check.detail}`).join("\n")}\n\n${result.summary}`);
    if (!result.passed) process.exitCode = 3;
  });

  addSimulatedCommand(program, "nodes");
  addSimulatedCommand(program, "jobs");
  program.command("metrics <group>").action(async (group: string) => forward(`infraenv metrics ${group}`));
  program.command("inspect <node>").action(async (node: string) => forward(`infraenv inspect ${node}`));
  addSimulatedCommand(program, "diagnose");

  const fault = program.command("fault");
  fault.command("clear <faultId>")
    .option("--environment <environmentId>", "clear a fault on a v0.2 Environment instance")
    .action(async (faultId: string, options: { environment?: string }) => {
      if (options.environment === undefined) {
        await forward(`infraenv fault clear ${faultId}`);
        return;
      }
      console.log(JSON.stringify(await clearSupervisorFault(options.environment, faultId), null, 2));
    });

  program.command("debug:docker-args").description("Print the active sidecar security posture").action(() => {
    console.log("Runtime and sandbox use: --read-only --security-opt no-new-privileges:true --cap-drop ALL --pids-limit --memory --cpus --tmpfs; no privileged mode, Docker socket, or host-directory mount.");
    console.log(`Docker client: ${docker(["--version"]).stdout || "unavailable"}`);
  });

  addV2Commands(program);

  program.configureOutput({ outputError: (message, write) => write(message) });
  return program;
}

function addSimulatedCommand(program: Command, name: string): void {
  program.command(name).action(async () => forward(`infraenv ${name}`));
}

async function forward(command: string): Promise<void> {
  const session = await loadSession();
  const result = await executeRemote(session, command);
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
}
