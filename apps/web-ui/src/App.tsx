import { useCallback, useEffect, useMemo, useState } from "react";
import type { RuntimeEvent, SimulationSnapshot, ValidationResult } from "@infraenv/shared";

type View = "overview" | "nodes" | "metrics" | "events";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...init.headers }
  });
  const body = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(body.message ?? `HTTP ${response.status}`);
  return body;
}

export function App() {
  const [state, setState] = useState<SimulationSnapshot>();
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [view, setView] = useState<View>("overview");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [validation, setValidation] = useState<ValidationResult>();

  const refresh = useCallback(async () => {
    const next = await request<SimulationSnapshot>("/v1/session/state");
    setState(next);
  }, []);

  useEffect(() => {
    let closed = false;
    const boot = async () => {
      try {
        const url = new URL(window.location.href);
        const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
        const launchToken = fragment.get("launchToken");
        if (launchToken) {
          await request("/v1/auth/exchange", { method: "POST", body: JSON.stringify({ launchToken }) });
          fragment.delete("launchToken");
          url.hash = fragment.toString();
          window.history.replaceState({}, "", url);
        }
        await refresh();
        if (closed) return;
        const socket = new WebSocket(`${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/v1/events`);
        socket.onmessage = (message) => {
          const event = JSON.parse(String(message.data)) as RuntimeEvent;
          setEvents((current) => [event, ...current].slice(0, 80));
          if (event.type === "state" && isSnapshot(event.data)) setState(event.data);
          if (event.type === "validation") setValidation(event.data as ValidationResult);
          void refresh();
        };
        socket.onerror = () => setError("实时事件连接中断；页面仍可手动刷新。");
        return () => socket.close();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "无法连接本地 Runtime。");
      }
    };
    const cleanupPromise = boot();
    return () => {
      closed = true;
      void cleanupPromise.then((cleanup) => cleanup?.());
    };
  }, [refresh]);

  const act = async (path: string, body?: unknown) => {
    setBusy(true);
    setError("");
    try {
      const next = await request<SimulationSnapshot>(path, { method: "POST", body: JSON.stringify(body ?? {}) });
      setState(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败。");
    } finally {
      setBusy(false);
    }
  };

  const activeFault = state?.faults.some((fault) => fault.active) ?? false;
  const slowest = useMemo(() => state?.nodes.reduce((current, node) => node.network.bandwidthGbps < current.network.bandwidthGbps ? node : current), [state]);

  if (!state) {
    return <main className="boot"><span className="pulse" /> <p>{error || "正在连接本地模拟 Runtime…"}</p></main>;
  }
  const can = (action: string) => state.allowedUiActions.includes(action);

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="/app/" aria-label="InfraEnv console home">
          <span className="brand-mark">IE</span>
          <span><strong>InfraEnv</strong><small>LOCAL SIMULATION CONSOLE</small></span>
        </a>
        <div className="disclosure"><span /> SIMULATED / S2</div>
        <div className="session"><small>SESSION</small><code>{state.sessionId.slice(-13)}</code></div>
      </header>

      <div className="workspace">
        <aside className="sidebar" aria-label="Console sections">
          {(["overview", "nodes", "metrics", "events"] as const).map((item) => (
            <button key={item} className={view === item ? "active" : ""} onClick={() => setView(item)}>
              <span>{item === "overview" ? "01" : item === "nodes" ? "02" : item === "metrics" ? "03" : "04"}</span>
              {item === "overview" ? "总览" : item === "nodes" ? "节点矩阵" : item === "metrics" ? "指标" : "事件"}
            </button>
          ))}
          <div className="sidebar-note">
            <strong>行为级模拟</strong>
            <p>数值用于学习因果关系，不代表真实 H100、NCCL 或集群性能。</p>
          </div>
        </aside>

        <main className="content">
          <section className="page-heading">
            <div><p className="eyebrow">LAB 01 · DISTRIBUTED TRAINING DIAGNOSTICS</p><h1>Find a Slow Worker</h1></div>
            <div className="controls" aria-label="Simulation controls">
              {can(state.status === "paused" ? "resume" : "pause") && <button disabled={busy} onClick={() => void act(state.status === "paused" ? "/v1/control/resume" : "/v1/control/pause")}>{state.status === "paused" ? "继续" : "暂停"}</button>}
              {can("reset") && <button disabled={busy} onClick={() => void act("/v1/control/reset")}>重置</button>}
              {activeFault && can("clear-listed-fault")
                ? <button className="repair" disabled={busy} onClick={() => void act(`/v1/faults/${encodeURIComponent(state.faults[0]?.id ?? "")}/clear`)}>清除链路故障</button>
                : !activeFault && can("inject-listed-fault") ? <button className="danger" disabled={busy} onClick={() => void act("/v1/faults/inject", { faultId: state.faults[0]?.id })}>注入允许故障</button> : null}
            </div>
          </section>

          {error && <div className="error" role="alert">{error}</div>}
          {view === "overview" && <Overview state={state} slowest={slowest?.id ?? "—"} validation={validation} />}
          {view === "nodes" && <Nodes state={state} />}
          {view === "metrics" && <Metrics state={state} />}
          {view === "events" && <Events events={events} state={state} />}
        </main>
      </div>
    </div>
  );
}

function Overview({ state, slowest, validation }: { state: SimulationSnapshot; slowest: string; validation: ValidationResult | undefined }) {
  const degraded = state.nodes.filter((node) => node.health !== "healthy").length;
  const target = state.faults[0]?.target ?? slowest;
  const targetNode = state.nodes.find((node) => node.id === target);
  const totalGpuCount = state.nodes.reduce((sum, node) => sum + node.gpus.length, 0);
  const gpusPerNode = state.nodes[0]?.gpus.length ?? 0;
  const baselineBandwidth = Math.max(...state.nodes.map((node) => node.network.bandwidthGbps));
  return <>
    <div className="metric-grid">
      <Metric label="逻辑 GPU" value={String(totalGpuCount)} unit={`${state.nodes.length} nodes × ${gpusPerNode}`} />
      <Metric label="Step Time" value={state.training.stepTimeMs.toFixed(1)} unit="ms" alert={state.training.stepTimeMs > 200} />
      <Metric label="吞吐" value={Math.round(state.training.throughputSamplesPerSecond).toLocaleString()} unit="samples/s" alert={state.training.stepTimeMs > 200} />
      <Metric label="异常节点" value={String(degraded)} unit={slowest} alert={degraded > 0} />
    </div>
    <div className="two-column">
      <section className="panel causal"><PanelTitle index="A" title="因果链" meta={`T+${state.virtualTimeSeconds}s`} />
        <ol>
          <li className={degraded ? "hot" : ""}><span>01</span>{target} 带宽 {targetNode?.network.bandwidthGbps ?? baselineBandwidth} Gbps（基线 {baselineBandwidth}）</li>
          <li className={degraded ? "hot" : ""}><span>02</span>{target} Worker 通信耗时上升</li>
          <li className={degraded ? "hot" : ""}><span>03</span>其他 Rank 等待同步</li>
          <li className={degraded ? "hot" : ""}><span>04</span>Step Time 上升、吞吐下降</li>
        </ol>
      </section>
      <section className="panel"><PanelTitle index="B" title="调查进度" meta={`${state.observations.commands.length} commands`} />
        <Checklist done={state.observations.metricGroups.includes("network")} text="比较集群网络指标" />
        <Checklist done={state.observations.metricGroups.includes("gpu")} text="区分 GPU 症状与根因" />
        <Checklist done={state.observations.inspectedNodes.includes(target)} text={`检查 ${target} 跨层状态`} />
        <Checklist done={state.hypothesis?.target === target} text="提交根因与目标假设" />
        <Checklist done={!state.faults[0]?.active} text="清除故障并验证恢复" />
        {validation && <p className={`validation ${validation.passed ? "passed" : ""}`}>{validation.summary}</p>}
      </section>
    </div>
    <section className="panel terminal-help"><PanelTitle index="C" title="下一步：回到 Shell" meta="CLI IS AUTHORITATIVE" />
      <code>infraenv metrics network</code><code>infraenv metrics gpu</code><code>{`infraenv inspect ${target}`}</code><code>infraenv diagnose</code>
    </section>
  </>;
}

function Nodes({ state }: { state: SimulationSnapshot }) {
  return <section className="panel"><PanelTitle index="N" title={`${state.nodes.length} 节点矩阵`} meta={`${state.nodes[0]?.gpus.length ?? 0} SIMULATED GPU / NODE`} />
    <div className="node-grid">{state.nodes.map((node) => <article key={node.id} className={`node ${node.health}`}>
      <div><strong>{node.id}</strong><span>{node.health}</span></div>
      <b>{node.network.bandwidthGbps}<small> Gbps</small></b>
      <p>latency {node.network.latencyMs} ms</p>
      <div className="gpu-dots" aria-label={`${node.gpus.length} simulated GPUs`}>{node.gpus.map((gpu) => <i key={gpu.index} style={{ opacity: Math.max(.35, gpu.utilizationPercent / 100) }} />)}</div>
    </article>)}</div>
  </section>;
}

function Metrics({ state }: { state: SimulationSnapshot }) {
  const maxWait = Math.max(...state.nodes.map((node) => node.communicationWaitMs), 1);
  return <div className="two-column metrics-view">
    <section className="panel"><PanelTitle index="M1" title="网络带宽" meta="GBPS" />
      <div className="bars">{state.nodes.map((node) => <div className="bar-row" key={node.id}><span>{node.id}</span><i><b className={node.health === "degraded" ? "bad" : ""} style={{ width: `${node.network.bandwidthGbps / 4}%` }} /></i><em>{node.network.bandwidthGbps}</em></div>)}</div>
    </section>
    <section className="panel"><PanelTitle index="M2" title="通信等待" meta="MILLISECONDS" />
      <div className="bars">{state.nodes.map((node) => <div className="bar-row" key={node.id}><span>{node.id}</span><i><b className={node.communicationWaitMs > 100 ? "warn" : ""} style={{ width: `${node.communicationWaitMs / maxWait * 100}%` }} /></i><em>{node.communicationWaitMs}</em></div>)}</div>
    </section>
  </div>;
}

function Events({ events, state }: { events: RuntimeEvent[]; state: SimulationSnapshot }) {
  const initial: RuntimeEvent = { type: "notice", at: new Date(Date.now() - state.virtualTimeSeconds * 1000).toISOString(), data: `Scenario started with deterministic seed ${state.seed}.` };
  return <section className="panel"><PanelTitle index="E" title="会话事件" meta="LOCAL ONLY" />
    <ol className="timeline">{[...events, initial].map((event, index) => <li key={`${event.at}-${index}`}><time>{new Date(event.at).toLocaleTimeString()}</time><span>{event.type}</span><p>{eventSummary(event)}</p></li>)}</ol>
  </section>;
}

function Metric({ label, value, unit, alert }: { label: string; value: string; unit: string; alert?: boolean }) {
  return <article className={`metric ${alert ? "alert" : ""}`}><p>{label}</p><strong>{value}</strong><span>{unit}</span></article>;
}

function PanelTitle({ index, title, meta }: { index: string; title: string; meta: string }) {
  return <header className="panel-title"><span>{index}</span><h2>{title}</h2><small>{meta}</small></header>;
}

function Checklist({ done, text }: { done: boolean; text: string }) {
  return <div className={`check ${done ? "done" : ""}`}><span>{done ? "✓" : "·"}</span>{text}</div>;
}

function isSnapshot(value: unknown): value is SimulationSnapshot {
  return Boolean(value && typeof value === "object" && "sessionId" in value && "nodes" in value);
}

function eventSummary(event: RuntimeEvent): string {
  if (typeof event.data === "string") return event.data;
  if (event.type === "command") return `Executed ${(event.data as { command?: string }).command ?? "command"}.`;
  if (event.type === "validation") return (event.data as ValidationResult).summary;
  if (event.type === "state") return `Simulation state revision ${(event.data as SimulationSnapshot).revision}.`;
  return "Runtime event.";
}
