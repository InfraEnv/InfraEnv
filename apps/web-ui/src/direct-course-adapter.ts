import type { LabDefinition, SimulationSnapshot } from "@infraenv/shared";
import { findSlowWorkerLab } from "@infraenv/simulation";

export interface DirectCourseStep {
  id: string;
  title: string;
  command?: string;
  complete: boolean;
}

/**
 * Project the canonical lab definition onto Direct Runtime observation state.
 *
 * The first three host-side steps happen before the browser attaches, so the
 * direct adapter deliberately treats them as complete. Titles and commands
 * always come from LabDefinition; this module owns only completion semantics.
 */
export function deriveDirectCourseSteps(
  snapshot: SimulationSnapshot,
  lab: LabDefinition = findSlowWorkerLab
): DirectCourseStep[] {
  const commands = new Set(snapshot.observations.commands);
  const includesAll = (...values: string[]) => values.every((value) => commands.has(value));
  const completion = new Map<string, boolean>([
    ["step:doctor", true],
    ["step:list-labs", true],
    ["step:start-lab", true],
    ["step:inspect-gpu-inventory", commands.has("nvidia-smi")],
    ["step:inspect-scheduler", includesAll("sinfo", "squeue", "nodes", "jobs")],
    ["step:network-metrics", snapshot.observations.metricGroups.includes("network")],
    ["step:gpu-metrics", snapshot.observations.metricGroups.includes("gpu")],
    ["step:inspect-node03", snapshot.observations.inspectedNodes.includes("node03")],
    ["step:diagnose", commands.has("diagnose")],
    [
      "step:submit-diagnosis",
      snapshot.hypothesis?.rootCause === "network.bandwidth_drop" && snapshot.hypothesis.target === "node03"
    ],
    [
      "step:clear-fault",
      snapshot.faults.some((fault) => fault.id === "fault:node03-bandwidth" && !fault.active)
    ],
    ["step:final-submit", snapshot.status === "passed"]
  ]);

  return lab.steps.map((step) => ({
    id: step.id,
    title: step.title,
    ...(step.command ? { command: step.command } : {}),
    complete: completion.get(step.id) ?? false
  }));
}

/** Convert Direct Runtime action names into the Web UI capability dialect. */
export function deriveDirectRuntimeCapabilities(allowedUiActions: readonly string[]): string[] {
  return [
    "control.pause",
    "control.resume",
    "control.reset",
    ...(allowedUiActions.includes("inject-listed-fault") ? ["fault.inject"] : []),
    ...(allowedUiActions.includes("clear-listed-fault") ? ["fault.clear"] : [])
  ];
}
