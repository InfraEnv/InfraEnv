import type {
  DeclarativeValidator,
  LabDefinition,
  SimulationSnapshot,
  ValidationCheck,
  ValidationResult
} from "@infraenv/shared";

function compare(operator: "gte" | "lte", actual: number, expected: number): boolean {
  return operator === "gte" ? actual >= expected : actual <= expected;
}

function metricValue(metric: string, snapshot: SimulationSnapshot): number {
  if (metric === "training.step_time_ms") return snapshot.training.stepTimeMs;
  if (metric === "training.throughput_samples_per_second") return snapshot.training.throughputSamplesPerSecond;
  if (metric === "node03.network.bandwidth_gbps") return snapshot.nodes.find((node) => node.id === "node03")?.network.bandwidthGbps ?? 0;
  return Number.NaN;
}

function observationPassed(observation: Extract<DeclarativeValidator, { kind: "observation-recorded" }>["observation"], snapshot: SimulationSnapshot): boolean {
  if (observation === "metrics.network") return snapshot.observations.metricGroups.includes("network");
  if (observation === "metrics.gpu") return snapshot.observations.metricGroups.includes("gpu");
  return snapshot.observations.inspectedNodes.length > 0;
}

export function validateRule(rule: DeclarativeValidator, snapshot: SimulationSnapshot): ValidationCheck {
  if (rule.kind === "observation-recorded") {
    const passed = observationPassed(rule.observation, snapshot);
    return { id: rule.id, label: `已记录 ${rule.observation}`, passed, detail: passed ? "观察记录存在。" : `先完成 ${rule.observation} 观察。` };
  }
  if (rule.kind === "target-inspected") {
    const passed = snapshot.observations.inspectedNodes.includes(rule.target);
    return { id: rule.id, label: `已检查 ${rule.target}`, passed, detail: passed ? "节点检查记录存在。" : `先执行 infraenv inspect ${rule.target}。` };
  }
  if (rule.kind === "diagnosis-matches") {
    const passed = snapshot.hypothesis?.rootCause === rule.rootCause && snapshot.hypothesis.target === rule.target;
    return { id: rule.id, label: "根因与目标正确", passed, detail: passed ? `${rule.target} 的 ${rule.rootCause}。` : "根因或目标不正确；继续比较跨层指标。" };
  }
  if (rule.kind === "fault-state") {
    const fault = snapshot.faults.find((candidate) => candidate.id === rule.faultId);
    const passed = rule.state === "cleared" ? Boolean(fault && !fault.active) : Boolean(fault?.active);
    return { id: rule.id, label: `故障状态为 ${rule.state}`, passed, detail: passed ? `${rule.faultId} 状态正确。` : `${rule.faultId} 尚未达到 ${rule.state}。` };
  }
  const actual = metricValue(rule.metric, snapshot);
  const passed = Number.isFinite(actual) && compare(rule.operator, actual, rule.value);
  return {
    id: rule.id,
    label: `${rule.metric} ${rule.operator === "gte" ? "≥" : "≤"} ${rule.value} ${rule.unit}`,
    passed,
    detail: Number.isFinite(actual) ? `当前值 ${actual} ${rule.unit}。` : `Runtime 不支持指标 ${rule.metric}。`
  };
}

/** Evaluates a fixed declarative rule set. It never imports or executes curriculum code. */
export function validateLab(lab: LabDefinition, snapshot: SimulationSnapshot): ValidationResult {
  const checks = lab.validators.map((rule) => validateRule(rule, snapshot));
  const passed = checks.every((check) => check.passed);
  return {
    passed,
    checks,
    summary: passed ? "实验通过：诊断路径、根因判断、修复和恢复指标均满足要求。" : `尚未通过：${checks.filter((check) => !check.passed).length} 项要求未满足。`
  };
}
