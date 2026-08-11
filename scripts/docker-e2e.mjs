import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

const suffix = randomBytes(4).toString("hex");
const network = `infraenv-e2e-${suffix}`;
const hostNetwork = `infraenv-host-e2e-${suffix}`;
const runtime = `infraenv-runtime-e2e-${suffix}`;
const sandbox = `infraenv-sandbox-e2e-${suffix}`;
const nonTtySandbox = `infraenv-sandbox-nontty-e2e-${suffix}`;
const volume = `infraenv-progress-e2e-${suffix}`;
const sessionId = `session-e2e-${suffix}`;
const tokens = { host: randomBytes(24).toString("base64url"), sandbox: randomBytes(24).toString("base64url"), ui: randomBytes(24).toString("base64url") };

function docker(args, options = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8", windowsHide: true, timeout: options.timeout ?? 30_000, ...(options.input ? { input: options.input } : {}) });
  if (!options.allowFailure && result.status !== 0) throw new Error(`docker ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return { status: result.status ?? 1, stdout: result.stdout?.trim() ?? "", stderr: result.stderr?.trim() ?? "" };
}

function security(kind) {
  return ["--read-only", "--security-opt", "no-new-privileges:true", "--cap-drop", "ALL", "--pids-limit", "256", "--memory", kind === "runtime" ? "768m" : "1024m", "--cpus", "2", "--tmpfs", "/tmp:rw,noexec,nosuid,size=128m"];
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForHealth(url) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch { /* startup race */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error("Runtime health check timed out.");
}

const daemon = docker(["info", "--format", "{{.OSType}}"], { allowFailure: true });
if (daemon.status !== 0) throw new Error("Docker daemon is unavailable. Start Docker Desktop and rerun npm run test:docker.");
if (daemon.stdout !== "linux") throw new Error(`Docker must use Linux containers; current OSType is ${daemon.stdout}.`);
for (const image of ["infraenv/runtime:0.2.0-alpha.0", "infraenv/sandbox:0.2.0-alpha.0"]) {
  if (docker(["image", "inspect", image], { allowFailure: true }).status !== 0) throw new Error(`Missing ${image}. Run npm run docker:build first.`);
}

let runtimeStopped = false;
try {
  docker(["network", "create", "--internal", network]);
  docker(["network", "create", hostNetwork]);
  docker(["volume", "create", volume]);
  docker([
    "run", "-d", "--name", runtime, "--network", hostNetwork, "--network", network, ...security("runtime"),
    "--tmpfs", "/run:rw,nosuid,size=16m", "--mount", `type=volume,source=${volume},target=/data`,
    "-e", "INFRAENV_PORT=8080", "-e", "INFRAENV_UI_ROOT=/opt/infraenv/ui", "-e", "INFRAENV_PROGRESS_FILE=/data/progress.jsonl",
    "-e", `INFRAENV_SESSION_ID=${sessionId}`, "-e", `INFRAENV_HOST_TOKEN=${tokens.host}`, "-e", `INFRAENV_SANDBOX_TOKEN=${tokens.sandbox}`, "-e", `INFRAENV_UI_LAUNCH_TOKEN=${tokens.ui}`,
    "-e", "INFRAENV_CURRICULUM_CHECKSUM=sha256-e2e", "-p", "127.0.0.1:0:8080", "infraenv/runtime:0.2.0-alpha.0"
  ]);
  const port = docker(["port", runtime, "8080/tcp"]).stdout.match(/:(\d+)$/)?.[1];
  assert(port, "Could not resolve the loopback runtime port.");
  const origin = `http://127.0.0.1:${port}`;
  await waitForHealth(`${origin}/healthz`);
  const uiResponse = await fetch(`${origin}/app/`);
  assert(uiResponse.ok && (await uiResponse.text()).includes('<div id="root"></div>'), "Built Web UI was not served by the runtime sidecar.");
  assert((await fetch(`${origin}/v1/session/state`)).status === 401, "Unauthenticated API request was not rejected.");
  const uiExchange = await fetch(`${origin}/v1/auth/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ launchToken: tokens.ui })
  });
  assert(uiExchange.ok && uiExchange.headers.get("set-cookie")?.includes("infraenv_session="), "UI launch token did not produce a session cookie.");
  assert((await fetch(`${origin}/v1/auth/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ launchToken: tokens.ui })
  })).status === 401, "UI launch token was reusable.");

  const nonTty = docker([
    "run", "--rm", "-i", "--name", nonTtySandbox, "--network", network, ...security("sandbox"),
    "--tmpfs", "/home/learner:rw,nosuid,size=256m,uid=10001,gid=10001,mode=0755",
    "-e", `INFRAENV_API_URL=http://${runtime}:8080/v1`, "-e", `INFRAENV_SANDBOX_TOKEN=${tokens.sandbox}`,
    "infraenv/sandbox:0.2.0-alpha.0"
  ], { input: "exit\n" });
  assert(nonTty.stdout.includes("InfraEnv Ubuntu Learning Sandbox") && nonTty.stdout.includes("SIMULATED / S2"), "Non-TTY real Bash lifecycle did not start and exit cleanly.");

  docker([
    "run", "-d", "--name", sandbox, "--network", network, ...security("sandbox"),
    "--tmpfs", "/home/learner:rw,nosuid,size=256m,uid=10001,gid=10001,mode=0755",
    "-e", `INFRAENV_API_URL=http://${runtime}:8080/v1`, "-e", `INFRAENV_SANDBOX_TOKEN=${tokens.sandbox}`,
    "--entrypoint", "sleep", "infraenv/sandbox:0.2.0-alpha.0", "infinity"
  ]);

  const networkInspect = JSON.parse(docker(["network", "inspect", network]).stdout)[0];
  assert(networkInspect.Internal === true, "Session network is not internal.");
  const hostNetworkInspect = JSON.parse(docker(["network", "inspect", hostNetwork]).stdout)[0];
  assert(hostNetworkInspect.Internal === false, "Runtime host bridge must support loopback port publishing.");
  for (const name of [runtime, sandbox]) {
    const inspected = JSON.parse(docker(["inspect", name]).stdout)[0];
    assert(inspected.HostConfig.Privileged === false, `${name} is privileged.`);
    assert(inspected.HostConfig.ReadonlyRootfs === true, `${name} root is writable.`);
    assert(inspected.HostConfig.CapDrop?.includes("ALL"), `${name} did not drop all capabilities.`);
    assert(inspected.HostConfig.SecurityOpt?.some((value) => value.includes("no-new-privileges")), `${name} lacks no-new-privileges.`);
    assert(!inspected.HostConfig.Binds?.length, `${name} has a host bind mount.`);
    assert(!inspected.Mounts?.some((mount) => mount.Type === "bind" || mount.Destination === "/var/run/docker.sock"), `${name} exposes a host bind or Docker socket.`);
  }
  const runtimeInspect = JSON.parse(docker(["inspect", runtime]).stdout)[0];
  assert(Object.hasOwn(runtimeInspect.NetworkSettings.Networks, network), "Runtime is not attached to the internal session network.");
  assert(Object.hasOwn(runtimeInspect.NetworkSettings.Networks, hostNetwork), "Runtime is not attached to its host bridge.");
  const sandboxInspect = JSON.parse(docker(["inspect", sandbox]).stdout)[0];
  assert(Object.keys(sandboxInspect.NetworkSettings.Networks).length === 1 && Object.hasOwn(sandboxInspect.NetworkSettings.Networks, network), "Sandbox escaped the internal-only network boundary.");
  assert(runtimeInspect.HostConfig.PortBindings["8080/tcp"][0].HostIp === "127.0.0.1", "Runtime API is not loopback-only.");
  assert(docker(["exec", sandbox, "bash", "-lc", ". /etc/os-release && test \"$ID\" = ubuntu"]).status === 0, "Sandbox is not a real Ubuntu userspace.");
  const egress = docker(["exec", sandbox, "python3", "-c", "import urllib.request; urllib.request.urlopen('https://example.com', timeout=2)"], { allowFailure: true, timeout: 5_000 });
  assert(egress.status !== 0, "Sandbox unexpectedly reached the public Internet.");

  for (const command of [
    ["nvidia-smi"], ["sinfo"], ["squeue"], ["infraenv", "nodes"], ["infraenv", "jobs"],
    ["infraenv", "metrics", "network"], ["infraenv", "metrics", "gpu"], ["infraenv", "inspect", "node03"], ["infraenv", "diagnose"]
  ]) {
    const result = docker(["exec", sandbox, ...command]);
    assert(result.stdout.includes("SIMULATED / S2"), `${command.join(" ")} omitted the simulation disclosure.`);
  }
  const diagnosisOnly = docker(["exec", sandbox, "infraenv", "lab", "submit", "--root-cause", "network.bandwidth_drop", "--target", "node03"], { allowFailure: true });
  assert(diagnosisOnly.status === 3, `Diagnosis-only submission should be not-yet-passed (3), got ${diagnosisOnly.status}.`);
  assert(diagnosisOnly.stdout.includes("SIMULATED / S2"), "Diagnosis submission omitted the simulation disclosure.");
  const repaired = docker(["exec", sandbox, "infraenv", "fault", "clear", "fault:node03-bandwidth"]);
  assert(repaired.stdout.includes("SIMULATED / S2"), "Fault repair omitted the simulation disclosure.");
  const completed = docker(["exec", sandbox, "infraenv", "lab", "submit"]);
  assert(completed.stdout.includes("SIMULATED / S2"), "Final validation omitted the simulation disclosure.");
  const stateResponse = await fetch(`${origin}/v1/session/state`, { headers: { authorization: `Bearer ${tokens.host}` } });
  const state = await stateResponse.json();
  assert(state.status === "passed", "Complete sandbox lab sequence did not pass.");
  assert(state.sessionId === sessionId, "Host, runtime and progress session IDs diverged.");
  assert(state.nodes.flatMap((node) => node.gpus).length === 128, "Runtime did not expose 128 logical GPUs.");

  docker(["stop", "--time", "10", runtime], { timeout: 15_000 });
  runtimeStopped = true;
  const jsonl = docker(["run", "--rm", "--user", "0:0", "--mount", `type=volume,source=${volume},target=/data,readonly`, "--entrypoint", "cat", "infraenv/sandbox:0.2.0-alpha.0", "/data/progress.jsonl"]).stdout;
  assert(jsonl.includes('"event":"session.stopped"'), "Graceful container stop did not persist session.stopped.");
  const records = jsonl.trim().split("\n").map((line) => JSON.parse(line));
  for (const record of records) {
    assert(record.sessionId === sessionId, "Learning record sessionId drifted from the host session.");
    assert(record.contentVersion === "0.2.0-alpha.0", "Learning record contentVersion is missing or incorrect.");
    assert(record.runtimeVersion === "0.2.0-alpha.0", "Learning record Runtime identity is missing or incorrect.");
    assert(record.scenarioId === "scenario:slow-worker-bandwidth-drop" && record.scenarioVersion === "2.0.0", "Learning record Scenario identity is missing or incorrect.");
    assert(record.curriculumChecksum === "sha256-e2e", "Learning record curriculum checksum is missing or incorrect.");
  }
  console.log("Docker E2E passed: isolation, real Ubuntu shell, 128 simulated GPUs, diagnosis, repair, validation and graceful JSONL stop.");
} finally {
  docker(["rm", "-f", sandbox], { allowFailure: true });
  docker(["rm", "-f", nonTtySandbox], { allowFailure: true });
  if (!runtimeStopped) docker(["stop", "--time", "10", runtime], { allowFailure: true, timeout: 15_000 });
  docker(["rm", "-f", runtime], { allowFailure: true });
  docker(["network", "rm", network], { allowFailure: true });
  docker(["network", "rm", hostNetwork], { allowFailure: true });
  docker(["volume", "rm", volume], { allowFailure: true });
}
