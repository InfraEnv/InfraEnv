import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { SimulationSnapshot } from "@infraenv/shared";
import {
  SupervisorApiError,
  bootstrapSupervisor,
  clearFault,
  cloneEnvironment,
  connectStorage,
  controlInstance,
  createCheckpoint,
  createEnvironment,
  deleteEnvironment,
  directRuntimeControl,
  directRuntimeClearFault,
  directRuntimeInjectFault,
  exchangeLaunchToken,
  exportEnvironment,
  getDirectRuntimeState,
  getEnvironment,
  getInstance,
  importEnvironment,
  injectFault,
  purgeEnvironment,
  restoreCheckpoint,
  restoreEnvironment,
  startEnvironment,
  startSymbolicLoad,
  updateEnvironment
} from "./api.js";
import { deriveDirectCourseSteps, deriveDirectRuntimeCapabilities } from "./direct-course-adapter.js";
import { TerminalPanel } from "./TerminalPanel.js";
import { EmptyPanel, PanelHeading, TopologyPanel } from "./TopologyPanel.js";
import {
  EMPTY_DRAFT,
  type BootstrapData,
  type ConnectionMode,
  type EnvironmentDraft,
  type EnvironmentSummary,
  type InstanceDetail,
  type InstanceSummary,
  type MetricSample,
  type PresetSummary,
  type RuntimeTimelineEvent
} from "./types.js";

type Page = "environments" | "builder" | "instances" | "workbench" | "about";
type WorkbenchView = "overview" | "topology" | "metrics" | "boot" | "events" | "faults" | "storage" | "placement" | "checkpoints";

interface Route {
  page: Page;
  id?: string | undefined;
  preset?: string | undefined;
  view?: WorkbenchView | undefined;
}

const EMPTY_BOOTSTRAP: BootstrapData = {
  status: { apiVersion: "unavailable" }, environments: [], presets: [], instances: [], trash: []
};
export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute());
  const [connection, setConnection] = useState<ConnectionMode>("loading");
  const [data, setData] = useState<BootstrapData>(EMPTY_BOOTSTRAP);
  const [detail, setDetail] = useState<InstanceDetail>();
  const [directSnapshot, setDirectSnapshot] = useState<SimulationSnapshot>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [lastUpdated, setLastUpdated] = useState<Date>();
  const [theme, setTheme] = useState<"light" | "dark">(() => preferredTheme());
  const [launchEnvironment, setLaunchEnvironment] = useState<string | undefined>(() => new URLSearchParams(window.location.search).get("environment") ?? undefined);

  const navigate = useCallback((next: Route) => {
    window.location.hash = routeHash(next);
  }, []);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setConnection("loading");
    setError("");
    try {
      const next = await bootstrapSupervisor();
      setData(next);
      setDirectSnapshot(undefined);
      setConnection("supervisor");
      setLastUpdated(new Date());
      return;
    } catch (cause) {
      const supervisorError = cause instanceof SupervisorApiError ? cause : new SupervisorApiError("Supervisor 返回了未知错误。");
      if (!supervisorError.unavailable) {
        setConnection("error");
        setError(supervisorError.message);
        return;
      }
    }

    try {
      const snapshot = await getDirectRuntimeState<SimulationSnapshot>();
      const adapted = adaptDirectRuntime(snapshot);
      setDirectSnapshot(snapshot);
      setData(adapted.bootstrap);
      setDetail(adapted.detail);
      setConnection("direct-runtime");
      setLastUpdated(new Date());
    } catch {
      setData(EMPTY_BOOTSTRAP);
      setDirectSnapshot(undefined);
      setDetail(undefined);
      setConnection("offline");
      setLastUpdated(new Date());
    }
  }, []);

  useEffect(() => {
    const listener = () => setRoute(parseRoute());
    window.addEventListener("hashchange", listener);
    void exchangeLaunchToken().finally(() => void refresh());
    return () => window.removeEventListener("hashchange", listener);
  }, [refresh]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("infraenv-theme", theme);
  }, [theme]);

  useEffect(() => {
    const instanceId = route.page === "workbench" ? route.id : undefined;
    if (!instanceId || (connection !== "supervisor" && connection !== "direct-runtime")) return;
    let cancelled = false;
    const load = async () => {
      try {
        if (connection === "supervisor") {
          const next = await getInstance(instanceId);
          if (!cancelled) { setDetail(next); setLastUpdated(new Date()); }
        } else {
          const snapshot = await getDirectRuntimeState<SimulationSnapshot>();
          if (!cancelled) {
            const adapted = adaptDirectRuntime(snapshot);
            setDirectSnapshot(snapshot);
            setDetail(adapted.detail);
            setData(adapted.bootstrap);
            setLastUpdated(new Date());
          }
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "无法加载实例工作台。");
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [connection, route.id, route.page]);

  useEffect(() => {
    if (!launchEnvironment || connection !== "supervisor") return;
    const environment = data.environments.find((candidate) => candidate.id === launchEnvironment);
    setLaunchEnvironment(undefined);
    window.history.replaceState({}, "", `${window.location.pathname}${window.location.hash}`);
    if (!environment) {
      setError(`Web UI 启动参数引用了不存在的 Environment：${launchEnvironment}`);
      return;
    }
    navigate(environment.activeInstanceId
      ? { page: "workbench", id: environment.activeInstanceId, view: "overview" }
      : { page: "builder", id: environment.id });
  }, [connection, data.environments, launchEnvironment, navigate]);

  const run = async (key: string, operation: () => Promise<unknown>, after?: () => void) => {
    setBusy(key);
    setError("");
    try {
      await operation();
      await refresh(true);
      after?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败。");
    } finally {
      setBusy("");
    }
  };

  const openWorkbench = (instanceId: string, view: WorkbenchView = "overview") => navigate({ page: "workbench", id: instanceId, view });
  const canManage = connection === "supervisor";

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <header className="app-header">
        <button className="brand-button" type="button" onClick={() => navigate({ page: "environments" })} aria-label="返回 Environment 首页">
          <span className="brand-mark">IE</span><span><strong>InfraEnv</strong><small>LOCAL SIMULATION CONTROL PLANE</small></span>
        </button>
        <div className="simulation-badge"><i />SIMULATED / S2</div>
        <div className="header-actions">
          <ConnectionPill mode={connection} />
          <button className="icon-button" type="button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label={`切换为${theme === "dark" ? "亮色" : "暗色"}模式`}>{theme === "dark" ? "☀" : "◐"}</button>
          <button className="icon-button" type="button" onClick={() => void refresh()} aria-label="刷新 Supervisor 状态">↻</button>
        </div>
      </header>

      <div className="app-body">
        <nav className="primary-nav" aria-label="InfraEnv sections">
          <NavButton active={route.page === "environments"} icon="01" label="Environments" onClick={() => navigate({ page: "environments" })} />
          <NavButton active={route.page === "builder"} icon="02" label="Builder" onClick={() => navigate({ page: "builder" })} />
          <NavButton active={route.page === "instances"} icon="03" label="Instances" onClick={() => navigate({ page: "instances" })} />
          <NavButton active={route.page === "workbench"} icon="04" label="Workbench" onClick={() => navigate({ page: "workbench", id: runningInstanceId(data.instances), view: "overview" })} />
          <NavButton active={route.page === "about"} icon="05" label="System" onClick={() => navigate({ page: "about" })} />
          <div className="nav-boundary"><strong>S2 boundary</strong><p>对象和数值由确定性模型生成。页面不会把模拟值称为硬件实测。</p></div>
        </nav>

        <main id="main-content" className="app-main">
          <ConnectionBanner mode={connection} error={error} onRetry={() => void refresh()} />
          {connection === "loading" ? <LoadingState /> : (
            <>
              {error && connection !== "error" && <div className="alert error-alert" role="alert">{error}</div>}
              {route.page === "environments" && <EnvironmentHome
                data={data}
                mode={connection}
                busy={busy}
                onCreate={() => navigate({ page: "builder" })}
                onPreset={(preset) => navigate({ page: "builder", preset: preset.id })}
                onEdit={(environment) => navigate({ page: "builder", id: environment.id })}
                onOpen={openWorkbench}
                onStart={(environment) => void run(`start:${environment.id}`, () => startEnvironment(environment.id), () => navigate({ page: "instances" }))}
                onDelete={(environment) => {
                  if (window.confirm(`删除环境“${environment.name}”？持久 workspace 与 checkpoint 不会在未确认时自动删除。`)) {
                    void run(`delete:${environment.id}`, () => deleteEnvironment(environment.id));
                  }
                }}
                onClone={(environment) => {
                  const name = window.prompt("新 Environment 名称", `${environment.name}-copy`);
                  if (name?.trim()) void run(`clone:${environment.id}`, () => cloneEnvironment(environment.id, name.trim()));
                }}
                onExport={(environment) => void run(`export:${environment.id}`, () => exportEnvironment(environment.id))}
                onImport={(file) => void run("import", () => importEnvironment(file))}
                onRestore={(environment) => void run(`restore:${environment.id}`, () => restoreEnvironment(environment.id))}
                onPurge={(environment) => {
                  if (window.confirm(`永久清除“${environment.name}”及其全部 Snapshot、Checkpoint 与已停止/失败的 Instance 记录？此操作不可恢复。当前通用 Playground 未创建 Workspace volume。`)) void run(`purge:${environment.id}`, () => purgeEnvironment(environment.id));
                }}
              />}
              {route.page === "builder" && <EnvironmentBuilder
                connection={connection}
                environmentId={route.id}
                selectedPreset={data.presets.find((preset) => preset.id === route.preset)}
                presets={data.presets}
                onCancel={() => navigate({ page: "environments" })}
                onSaved={() => { void refresh(true); navigate({ page: "environments" }); }}
              />}
              {route.page === "instances" && <InstancesPage
                instances={data.instances}
                canManage={canManage}
                busy={busy}
                onOpen={openWorkbench}
                onControl={(instance, action) => void run(`${action}:${instance.id}`, () => controlInstance(instance.id, action))}
              />}
              {route.page === "workbench" && <Workbench
                instance={detail && (!route.id || detail.id === route.id) ? detail : undefined}
                requestedId={route.id}
                view={route.view ?? "overview"}
                connection={connection}
                busy={busy}
                lastUpdated={lastUpdated}
                onNavigate={(view) => navigate({ page: "workbench", id: route.id ?? detail?.id, view })}
                onSelectInstance={(id) => navigate({ page: "workbench", id, view: "overview" })}
                instances={data.instances}
                onControl={(action) => {
                  if (!detail) return;
                  if (connection === "direct-runtime" && (action === "pause" || action === "resume" || action === "reset")) {
                    void run(`${action}:${detail.id}`, async () => {
                      const snapshot = await directRuntimeControl<SimulationSnapshot>(action);
                      const adapted = adaptDirectRuntime(snapshot);
                      setDirectSnapshot(snapshot); setDetail(adapted.detail); setData(adapted.bootstrap);
                    });
                  } else if (connection === "supervisor") {
                    void run(`${action}:${detail.id}`, () => controlInstance(detail.id, action));
                  }
                }}
                onInject={(faultId, target) => {
                  if (!detail) return;
                  if (connection === "direct-runtime") {
                    void run(`fault:${faultId}`, async () => {
                      const snapshot = await directRuntimeInjectFault<SimulationSnapshot>(faultId);
                      const adapted = adaptDirectRuntime(snapshot);
                      setDirectSnapshot(snapshot); setDetail(adapted.detail); setData(adapted.bootstrap);
                    });
                  } else if (connection === "supervisor") void run(`fault:${faultId}`, async () => setDetail(await injectFault(detail.id, faultId, target)));
                }}
                onClear={(faultId) => {
                  if (!detail) return;
                  if (connection === "direct-runtime") {
                    void run(`fault:${faultId}`, async () => {
                      const snapshot = await directRuntimeClearFault<SimulationSnapshot>(faultId);
                      const adapted = adaptDirectRuntime(snapshot);
                      setDirectSnapshot(snapshot); setDetail(adapted.detail); setData(adapted.bootstrap);
                    });
                  } else if (connection === "supervisor") void run(`fault:${faultId}`, async () => setDetail(await clearFault(detail.id, faultId)));
                }}
                onCheckpointCreate={(name) => detail && void run(`checkpoint:create:${detail.id}`, async () => setDetail(await createCheckpoint(detail.id, name)))}
                onCheckpointRestore={(checkpointId) => detail && void run(`checkpoint:restore:${checkpointId}`, async () => setDetail(await restoreCheckpoint(detail.id, checkpointId)))}
                onStorageConnect={() => detail && void run(`storage:connect:${detail.id}`, async () => setDetail(await connectStorage(detail.id)))}
                onSymbolicLoad={(objectKey, sizeBytes) => detail && void run(`storage:load:${detail.id}`, async () => setDetail(await startSymbolicLoad(detail.id, objectKey, sizeBytes)))}
              />}
              {route.page === "about" && <SystemPage mode={connection} data={data} directSnapshot={directSnapshot} />}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function ConnectionPill({ mode }: { mode: ConnectionMode }) {
  const label = mode === "supervisor" ? "SUPERVISOR ONLINE" : mode === "direct-runtime" ? "DIRECT RUNTIME" : mode === "loading" ? "CHECKING" : mode === "error" ? "AUTH / API ERROR" : "OFFLINE";
  return <span className={`connection-pill ${mode}`} role="status"><i />{label}</span>;
}

function ConnectionBanner({ mode, error, onRetry }: { mode: ConnectionMode; error: string; onRetry(): void }) {
  if (mode === "supervisor" || mode === "loading") return null;
  if (mode === "direct-runtime") return <div className="alert direct-alert"><div><strong>课程 Runtime 已连接，但多实例 Supervisor 未运行。</strong><p>当前实验仍可观察和控制；Environment CRUD、存档、Web Terminal 与跨实例管理保持禁用。</p></div><button className="button ghost" onClick={onRetry}>重新检测</button></div>;
  if (mode === "error") return <div className="alert error-alert" role="alert"><div><strong>Supervisor 返回错误。</strong><p>{error || "检查本地会话授权与 API 版本。"}</p></div><button className="button ghost" onClick={onRetry}>重试</button></div>;
  return <div className="alert offline-alert"><div><strong>Offline · 未连接 Supervisor。</strong><p>运行 <code>infraenv webui</code> 后刷新。现在只展示本地界面结构，不会保存、启动或修改任何环境。</p></div><button className="button ghost" onClick={onRetry}>重新检测</button></div>;
}

function NavButton({ active, icon, label, onClick }: { active: boolean; icon: string; label: string; onClick(): void }) {
  return <button type="button" className={active ? "active" : ""} aria-current={active ? "page" : undefined} onClick={onClick}><span>{icon}</span>{label}</button>;
}

function LoadingState() {
  return <div className="loading-state" role="status"><span className="spinner" /><strong>正在检查本地 Control Plane</strong><p>只连接 127.0.0.1，不探测公网服务。</p></div>;
}

function EnvironmentHome({ data, mode, busy, onCreate, onPreset, onEdit, onOpen, onStart, onDelete, onClone, onExport, onImport, onRestore, onPurge }: {
  data: BootstrapData; mode: ConnectionMode; busy: string;
  onCreate(): void; onPreset(preset: PresetSummary): void; onEdit(environment: EnvironmentSummary): void;
  onOpen(instanceId: string): void; onStart(environment: EnvironmentSummary): void; onDelete(environment: EnvironmentSummary): void;
  onClone(environment: EnvironmentSummary): void; onExport(environment: EnvironmentSummary): void; onImport(file: File): void;
  onRestore(environment: EnvironmentSummary): void; onPurge(environment: EnvironmentSummary): void;
}) {
  const canManage = mode === "supervisor";
  const capabilities = new Set(data.status.capabilities ?? []);
  const can = (capability: string) => canManage && capabilities.has(capability);
  return <div className="page-stack">
    <PageHeader eyebrow="ENVIRONMENT REGISTRY" title="Playgrounds 与课程预设" description="Environment 保存拓扑与配置；Instance 才是一次正在运行的模拟。课程使用不可编辑的版本化预设，Playground 由你定义。" actions={<><label className={`button ghost file-button ${!can("environment.import") ? "disabled" : ""}`} title={!can("environment.import") ? "Supervisor 未声明 environment.import capability" : "导入 InfraEnv JSON export；YAML 尚未启用"}>导入 JSON Definition<input type="file" accept=".json,application/json" disabled={!can("environment.import")} onChange={(event) => { const file = event.target.files?.[0]; if (file) onImport(file); event.currentTarget.value = ""; }} /></label><button className="button primary" type="button" onClick={onCreate}>创建 Environment</button></>} />
    <section aria-labelledby="environment-list-title">
      <SectionHeader id="environment-list-title" title="Your environments" meta={`${data.environments.length} saved`} />
      {data.environments.length ? <div className="card-grid">{data.environments.map((environment) => {
        const instance = data.instances.find((candidate) => candidate.id === environment.activeInstanceId && !isTerminalInstanceStatus(candidate.status) || candidate.environmentId === environment.id && !isTerminalInstanceStatus(candidate.status));
        return <article className="environment-card" key={environment.id}>
          <div className="card-topline"><span className={`mode-chip ${environment.mode}`}>{environment.mode}</span><span className={`status-dot ${instance?.status ?? "stopped"}`}>{instance?.status ?? "stopped"}</span></div>
          <h2>{environment.name}</h2><p>{environment.description || "没有说明。"}</p>
          <ResourceStrip resources={environment.resources} />
          <div className="card-meta"><span>rev {environment.revision}</span><span>{environment.sourceLabel ?? "custom"}</span><span>{formatDate(environment.updatedAt)}</span></div>
          <div className="card-actions">
            {instance ? <button className="button" type="button" onClick={() => onOpen(instance.id)}>打开工作台</button> : <button className="button" type="button" disabled={!can("environment.start") || busy === `start:${environment.id}`} title={!can("environment.start") ? "需要 environment.start capability" : undefined} onClick={() => onStart(environment)}>启动</button>}
            <button className="button ghost" type="button" disabled={!can("environment.update") || environment.mode === "course"} title={!can("environment.update") ? "需要 environment.update capability" : undefined} onClick={() => onEdit(environment)}>编辑</button>
            <details className="card-menu"><summary aria-label={`${environment.name} 更多操作`}>•••</summary><div><button type="button" disabled={!can("environment.clone")} title={!can("environment.clone") ? "需要 environment.clone capability" : undefined} onClick={() => onClone(environment)}>Clone</button><button type="button" disabled={!can("environment.export")} title={!can("environment.export") ? "需要 environment.export capability" : undefined} onClick={() => onExport(environment)}>Export</button><button className="danger-text" type="button" disabled={!can("environment.trash") || Boolean(instance) || environment.mode === "course"} title={!can("environment.trash") ? "需要 environment.trash capability" : undefined} onClick={() => onDelete(environment)}>Move to Trash</button></div></details>
          </div>
        </article>;
      })}</div> : <EmptyPanel title={mode === "offline" ? "Supervisor 未连接" : "还没有 Environment"} body={mode === "offline" ? "Builder 可以离线查看，但只有 Supervisor 在线后才能保存。" : "从空白 Builder 或一个版本化 Preset 创建第一个 Playground。"} action={<button className="button" onClick={onCreate}>打开 Builder</button>} />}
    </section>
    <section aria-labelledby="preset-list-title">
      <SectionHeader id="preset-list-title" title="Versioned presets" meta={`${data.presets.length} available`} />
      {data.presets.length ? <div className="preset-grid">{data.presets.map((preset) => <article className="preset-card" key={`${preset.id}@${preset.version}`}>
        <div><span>{preset.fidelity ?? preset.category ?? "cluster"}</span><code>{preset.version}</code></div><h3>{preset.name}</h3><p>{preset.description || "Supervisor 没有提供说明。"}</p>
        <ResourceStrip resources={preset.resources} compact />
        {preset.limitation && <small className="disabled-explanation">{preset.limitation}</small>}
        <button className="button ghost" type="button" disabled={preset.builderCompatible === false} title={preset.builderCompatible === false ? preset.limitation : "创建可编辑的 DERIVED / CUSTOM 副本"} onClick={() => onPreset(preset)}>派生为可编辑 Environment</button>
      </article>)}</div> : <EmptyPanel title="没有加载 Preset" body={mode === "supervisor" ? "Supervisor 返回了空的 Preset catalog。没有用占位数据伪造 NVIDIA 机柜模板。" : "Preset catalog 只能从本机 Supervisor 的版本化 hardware catalog 读取。"} />}
    </section>
    <section aria-labelledby="trash-list-title">
      <SectionHeader id="trash-list-title" title="Trash" meta="manual recovery and purge" />
      {!capabilities.has("environment.trash") ? <div className="capability-notice"><strong>Trash API 未启用</strong><p>恢复与永久清除入口保持可见但禁用。Supervisor 只有在声明 <code>environment.trash</code> 后才允许修改回收站。</p><div><button className="button compact" disabled>Restore</button><button className="button ghost compact" disabled>Purge</button></div></div>
        : data.trash.length ? <div className="trash-list">{data.trash.map((environment) => <article key={environment.id}><div><span>DELETED {formatDate(environment.deletedAt)}</span><h3>{environment.name}</h3><p>建议最早清理时间：{formatDateTime(environment.purgeAt)}（不会自动清理）</p></div><ResourceStrip resources={environment.resources} compact /><div><button className="button compact" disabled={Boolean(busy)} onClick={() => onRestore(environment)}>Restore</button><button className="button ghost compact danger-text" disabled={Boolean(busy)} onClick={() => onPurge(environment)}>Purge permanently</button></div></article>)}</div>
        : <EmptyPanel title="Trash 是空的" body="删除项会一直保留到手动 Restore 或 Purge。Purge 会永久删除该 Environment 的 Snapshot、Checkpoint 与终态 Instance 记录；当前 Playground 尚未创建持久 Workspace volume。" />}
    </section>
  </div>;
}

function EnvironmentBuilder({ connection, environmentId, selectedPreset, presets, onCancel, onSaved }: {
  connection: ConnectionMode; environmentId?: string | undefined; selectedPreset?: PresetSummary | undefined; presets: PresetSummary[]; onCancel(): void; onSaved(): void;
}) {
  const [draft, setDraft] = useState<EnvironmentDraft>(() => draftFromPreset(selectedPreset));
  const [loading, setLoading] = useState(Boolean(environmentId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!environmentId || connection !== "supervisor") { setLoading(false); return; }
    setLoading(true);
    void getEnvironment(environmentId).then((value) => setDraft(value)).catch((cause) => setError(cause instanceof Error ? cause.message : "无法加载 Environment。" )).finally(() => setLoading(false));
  }, [connection, environmentId]);
  useEffect(() => { if (!environmentId) setDraft(draftFromPreset(selectedPreset)); }, [environmentId, selectedPreset]);

  const setInventory = (key: keyof EnvironmentDraft["inventory"], value: string | number) => setDraft((current) => ({ ...current, inventory: { ...current.inventory, [key]: value } }));
  const setTopology = (key: keyof EnvironmentDraft["topology"], value: string) => setDraft((current) => ({ ...current, topology: { ...current.topology, [key]: value } } as EnvironmentDraft));
  const totalNodes = draft.inventory.rackCount * draft.inventory.nodesPerRack;
  const totalAccelerators = totalNodes * draft.inventory.acceleratorsPerNode;
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (connection !== "supervisor") return;
    if (!draft.name.trim()) { setError("Environment 名称不能为空。"); return; }
    setSaving(true); setError("");
    try {
      if (environmentId) await updateEnvironment(environmentId, draft);
      else await createEnvironment(draft);
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Environment 保存失败。");
    } finally { setSaving(false); }
  };

  if (loading) return <LoadingState />;
  return <div className="page-stack builder-page">
    <PageHeader eyebrow="DECLARATIVE BUILDER" title={environmentId ? "编辑 Environment" : "创建 Playground"} description="Builder 只保存声明式定义。GPU、显存、NVLink 与链路对象不会在宿主分配对应规模的真实资源。" />
    <form className="builder-layout" onSubmit={(event) => void save(event)}>
      <div className="builder-form">
        <fieldset><legend>01 · Identity & preset</legend>
          <div className="form-grid two"><Field label="名称" htmlFor="env-name"><input id="env-name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="my-training-cluster" required /></Field>
            <Field label="确定性 Seed" htmlFor="env-seed" hint="保存后相同 seed 与模型版本产生相同 jitter。"><input id="env-seed" type="number" min="0" value={draft.seed} onChange={(event) => setDraft({ ...draft, seed: numberValue(event.target.value, 0) })} /></Field></div>
          <Field label="说明" htmlFor="env-description"><textarea id="env-description" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} rows={3} placeholder="这个环境用于验证什么？" /></Field>
          <Field label="Preset" htmlFor="env-preset" hint="Preset 是版本化起点；保存后会固定引用版本。"><select id="env-preset" value={draft.source.templateId ?? ""} onChange={(event) => {
            const preset = presets.find((candidate) => candidate.id === event.target.value);
            setDraft(preset ? { ...draftFromPreset(preset), name: draft.name, description: draft.description, seed: draft.seed } : { ...draft, source: { kind: "playground" } });
          }}><option value="">Custom / no preset</option>{presets.map((preset) => <option key={`${preset.id}@${preset.version}`} value={preset.id} disabled={preset.builderCompatible === false}>{preset.name} · {preset.version}{preset.builderCompatible === false ? " · READ ONLY" : ""}</option>)}</select></Field>
        </fieldset>

        <fieldset><legend>02 · Physical hierarchy</legend>
          <div className="form-grid three">
            <Field label="Racks" htmlFor="rack-count"><input id="rack-count" type="number" min="1" max="128" value={draft.inventory.rackCount} onChange={(event) => setInventory("rackCount", numberValue(event.target.value, 1))} /></Field>
            <Field label="Nodes / rack" htmlFor="node-count"><input id="node-count" type="number" min="1" max="128" value={draft.inventory.nodesPerRack} onChange={(event) => setInventory("nodesPerRack", numberValue(event.target.value, 1))} /></Field>
            <Field label="Accelerators / node" htmlFor="gpu-count"><input id="gpu-count" type="number" min="1" max="16" value={draft.inventory.acceleratorsPerNode} onChange={(event) => setInventory("acceleratorsPerNode", numberValue(event.target.value, 1))} /></Field>
          </div>
          <Field label="Accelerator model" htmlFor="gpu-model" hint="自定义文本会由 Supervisor 标记 CUSTOM / UNVERIFIED；容量与吞吐只是显式的 S2 heuristic，不是已解析的 catalog 规格。"><input id="gpu-model" value={draft.inventory.acceleratorModel} onChange={(event) => setInventory("acceleratorModel", event.target.value)} /></Field>
        </fieldset>

        <fieldset><legend>03 · Communication topology</legend>
          <div className="form-grid two">
            <Field label="Intra-node" htmlFor="intra-node"><select id="intra-node" value={draft.topology.intraNode} onChange={(event) => setTopology("intraNode", event.target.value)}><option value="pcie">PCIe only</option><option value="nvlink">NVLink peer links</option><option value="nvswitch">NVSwitch fabric</option></select></Field>
            <Field label="NVLink generation" htmlFor="nvlink-generation" hint="作为 CUSTOM / UNVERIFIED 模型属性保存，不代表硬件兼容性验证。"><input id="nvlink-generation" value={draft.topology.nvlinkGeneration} onChange={(event) => setTopology("nvlinkGeneration", event.target.value)} disabled={draft.topology.intraNode === "pcie"} /></Field>
            <Field label="Inter-node" htmlFor="inter-node"><select id="inter-node" value={draft.topology.interNode} onChange={(event) => setTopology("interNode", event.target.value)}><option value="infiniband">InfiniBand</option><option value="ethernet">Ethernet / RoCE model</option></select></Field>
            <Field label="Inter-rack" htmlFor="inter-rack"><select id="inter-rack" value={draft.topology.interRack} onChange={(event) => setTopology("interRack", event.target.value)}><option value="fat-tree">Fat tree</option><option value="rail-optimized">Rail optimized</option><option value="dragonfly">Dragonfly</option></select></Field>
          </div>
        </fieldset>

        <fieldset><legend>04 · Persistence & optional services</legend>
          <label className="toggle-row"><input type="checkbox" checked={false} disabled /><span><strong>Persistent workspace · PLANNED</strong><small>独立 Docker named volume 尚未接入通用 Playground；当前定义不会承诺保存 Sandbox 文件。</small></span></label>
          <Field label="Object storage" htmlFor="object-storage" hint="当前只创建 S2 存储容量/服务对象，没有可 put/list/load 的对象目录。真实 S3 Gateway 已有安全库，但 Supervisor Connector 与凭据存储尚未接通。"><select id="object-storage" value={draft.objectStorage.mode === "s3-proxy" ? "disabled" : draft.objectStorage.mode} onChange={(event) => setDraft({ ...draft, objectStorage: { mode: event.target.value as EnvironmentDraft["objectStorage"]["mode"] } })}><option value="disabled">Disabled</option><option value="simulated">Simulated storage capacity object / S2</option><option value="s3-proxy" disabled>Host S3 proxy · PLANNED</option></select></Field>
        </fieldset>
        <div className="revision-notice"><strong>{environmentId ? "保存为 staged revision" : "创建 definition revision 1"}</strong><p>{environmentId ? "保存不会热改正在运行的对象。运行实例会显示 staged revision，只有显式 Apply / Reconcile 后才进入 reconciling，并在失败时保持旧 revision。" : "后续结构修改始终产生新 revision；Runtime 实例继续固定到启动时的 definition checksum。"}</p><code>SIMULATED / S2 · structural changes are declarative</code></div>
        {error && <div className="alert error-alert" role="alert">{error}</div>}
        <div className="form-actions"><button className="button ghost" type="button" onClick={onCancel}>取消</button><button className="button primary" type="submit" disabled={connection !== "supervisor" || saving}>{saving ? "保存中…" : environmentId ? "保存修订" : "创建 Environment"}</button></div>
        {connection !== "supervisor" && <p className="disabled-explanation">Supervisor 未连接，表单仅供预览，提交已禁用。</p>}
      </div>
      <aside className="builder-preview" aria-label="Environment definition summary">
        <p className="section-kicker">LIVE DEFINITION SUMMARY</p><h2>{draft.name || "Untitled environment"}</h2>
        <div className="definition-numbers"><strong>{totalAccelerators.toLocaleString()}<small>accelerators</small></strong><strong>{totalNodes.toLocaleString()}<small>nodes</small></strong><strong>{draft.inventory.rackCount}<small>racks</small></strong></div>
        <ol className="layer-stack"><li><span>L0</span><div><strong>{draft.inventory.acceleratorModel}</strong><small>{draft.inventory.acceleratorsPerNode} per node</small></div></li><li><span>L1</span><div><strong>{draft.topology.intraNode} · {draft.topology.nvlinkGeneration}</strong><small>intra-node fabric</small></div></li><li><span>L2</span><div><strong>{draft.topology.interNode}</strong><small>inter-node fabric</small></div></li><li><span>L3</span><div><strong>{draft.topology.interRack}</strong><small>inter-rack abstraction</small></div></li></ol>
        <div className="boundary-note"><strong>Model boundary</strong><p>有效带宽只能小于或等于 catalog 理论上限，并由 seed 与 performance model version 决定。它不是采购或容量规划依据。</p></div>
      </aside>
    </form>
  </div>;
}

function InstancesPage({ instances, canManage, busy, onOpen, onControl }: { instances: InstanceSummary[]; canManage: boolean; busy: string; onOpen(id: string): void; onControl(instance: InstanceSummary, action: "stop" | "restart" | "reset"): void }) {
  return <div className="page-stack"><PageHeader eyebrow="RUNTIME FLEET" title="Instances" description="Environment 是存档定义；Instance 是冻结到某个 Snapshot 的一次 S2 运行。通用 Playground 当前默认使用宿主模型；双容器 Sidecar + Sandbox 仍是能力门控目标。" />
    {instances.length ? <div className="instance-table-wrap"><table className="instance-table"><thead><tr><th>实例</th><th>环境</th><th>状态</th><th>资源</th><th>启动时间</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{instances.map((instance) => <tr key={instance.id}><td><code>{instance.id}</code><small>definition rev {instance.definitionRevision}</small></td><td><strong>{instance.environmentName}</strong><span className={`mode-chip ${instance.mode}`}>{instance.mode}</span></td><td><span className={`status-dot ${instance.status}`}>{instance.status}</span>{instance.apiReady === false && <small>API not ready</small>}</td><td>{instance.resources.nodes} nodes · {instance.resources.accelerators} GPU<small>{instance.resources.fabric ?? "fabric unknown"}</small></td><td>{formatDate(instance.startedAt)}</td><td><div className="table-actions"><button className="button compact" onClick={() => onOpen(instance.id)}>工作台</button>{isTerminalInstanceStatus(instance.status) ? <button className="button ghost compact" disabled={!canManage || Boolean(busy)} onClick={() => onControl(instance, "restart")}>重新启动</button> : <button className="button ghost compact" disabled={!canManage || Boolean(busy)} onClick={() => onControl(instance, "stop")}>停止</button>}</div></td></tr>)}</tbody></table></div>
      : <EmptyPanel title="没有运行记录" body={canManage ? "启动一个 Environment 后，boot state、健康状态和本地端口会出现在这里。" : "Supervisor 不在线，无法枚举本地 Instance。"} />}
  </div>;
}

function Workbench({ instance, requestedId, view, connection, busy, lastUpdated, onNavigate, onSelectInstance, instances, onControl, onInject, onClear, onCheckpointCreate, onCheckpointRestore, onStorageConnect, onSymbolicLoad }: {
  instance?: InstanceDetail | undefined; requestedId?: string | undefined; view: WorkbenchView; connection: ConnectionMode; busy: string; lastUpdated?: Date | undefined;
  onNavigate(view: WorkbenchView): void; onSelectInstance(id: string): void; instances: InstanceSummary[];
  onControl(action: "pause" | "resume" | "reset" | "stop" | "restart" | "reconcile"): void; onInject(faultId: string, target?: string): void; onClear(faultId: string): void;
  onCheckpointCreate(name: string): void; onCheckpointRestore(checkpointId: string): void; onStorageConnect(): void; onSymbolicLoad(objectKey: string, sizeBytes?: number): void;
}) {
  if (!requestedId && !instance) return <div className="page-stack"><PageHeader eyebrow="INSTANCE WORKBENCH" title="选择一个运行实例" description="Workbench 不会在没有 Runtime 状态时生成示例指标。" />{instances.length ? <div className="selection-list">{instances.map((item) => <button key={item.id} onClick={() => onSelectInstance(item.id)}><span className={`status-dot ${item.status}`}>{item.status}</span><strong>{item.environmentName}</strong><code>{item.id}</code></button>)}</div> : <EmptyPanel title="没有可选择的 Instance" body="先从 Environments 页面启动一个 Playground 或课程实验。" />}</div>;
  if (!instance) return <div className="loading-state" role="status"><span className="spinner" /><strong>正在加载 Instance</strong><p>{requestedId}</p></div>;
  const terminalEnabled = connection === "supervisor" && isReadyStatus(instance.status) && instance.capabilities?.includes("terminal.attach") === true;
  const mutableState = isMutableInstanceStatus(instance.status);
  const canReconcile = connection === "supervisor" && mutableState && Boolean(instance.stagedRevision) && Boolean(instance.capabilities?.includes("definition.reconcile"));
  return <div className="workbench-page">
    <PageHeader eyebrow={`INSTANCE · ${instance.mode.toUpperCase()}`} title={instance.environmentName} description={`${instance.disclosure} · ${instance.resources.racks} racks / ${instance.resources.nodes} nodes / ${instance.resources.accelerators} accelerators`} actions={<div className="workbench-controls"><select aria-label="切换 Instance" value={instance.id} onChange={(event) => onSelectInstance(event.target.value)}>{instances.map((item) => <option key={item.id} value={item.id}>{item.environmentName} · {item.status}</option>)}</select>{instance.status === "paused" ? <button className="button" disabled={Boolean(busy)} onClick={() => onControl("resume")}>继续</button> : <button className="button" disabled={Boolean(busy) || !isReadyStatus(instance.status)} onClick={() => onControl("pause")}>暂停</button>}<button className="button ghost" disabled={Boolean(busy) || !mutableState} title={!mutableState ? "只有 ready/paused Instance 可以重置" : undefined} onClick={() => onControl("reset")}>重置</button><button className="button ghost" disabled={!canReconcile || Boolean(busy)} title={!instance.capabilities?.includes("definition.reconcile") ? "Supervisor 未声明 definition.reconcile capability" : !mutableState ? "只有 ready/paused Instance 可以 reconcile" : !instance.stagedRevision ? "当前没有 staged revision" : undefined} onClick={() => onControl("reconcile")}>Apply staged revision</button></div>} />
    <div className="workbench-status"><span className={`status-dot ${instance.status}`}>{instance.status}</span><code>{instance.id}</code><span>definition rev {instance.definitionRevision}</span><span>{instance.virtualTimeSeconds !== undefined ? `T+${instance.virtualTimeSeconds}s` : "virtual clock unavailable"}</span><span>updated {lastUpdated?.toLocaleTimeString() ?? "—"}</span></div>
    <div className={`reconcile-notice ${instance.stagedRevision ? "staged" : ""}`}><strong>{instance.stagedRevision ? `Revision ${instance.stagedRevision} staged` : "No staged structural revision"}</strong><p>{instance.stagedRevision ? "Apply 会先进入 reconciling；失败时保留当前运行 revision，不会部分热改拓扑。" : "Builder 保存的新结构不会自动改变这个 Instance。结构变更必须显式 stage、校验并 reconcile。"}</p></div>
    <div className="workbench-layout">
      <WorkbenchContext instance={instance} active={view} onNavigate={onNavigate} />
      <div className="workbench-content"><WorkbenchPanel instance={instance} view={view} canMutate={connection === "supervisor" || connection === "direct-runtime"} busy={busy} onInject={onInject} onClear={onClear} onCheckpointCreate={onCheckpointCreate} onCheckpointRestore={onCheckpointRestore} onStorageConnect={onStorageConnect} onSymbolicLoad={onSymbolicLoad} /></div>
      <TerminalPanel instanceId={instance.id} enabled={terminalEnabled} unavailableReason={connection === "direct-runtime" ? "Direct Runtime 没有宿主 PTY broker；请在启动实验的宿主终端使用 Shell。" : !isReadyStatus(instance.status) ? "只有 ready Instance 可以附加 Terminal。" : "Supervisor 未声明 terminal.attach capability。"} />
    </div>
  </div>;
}

function WorkbenchContext({ instance, active, onNavigate }: { instance: InstanceDetail; active: WorkbenchView; onNavigate(view: WorkbenchView): void }) {
  const views: Array<[WorkbenchView, string]> = [["overview", "Overview"], ["topology", "Topology"], ["metrics", "Metrics"], ["boot", "Boot"], ["events", "Events"], ["faults", "Faults"], ["checkpoints", "Checkpoints"], ["storage", "Storage"], ["placement", "Placement"]];
  return <aside className="context-rail" aria-label="Workbench panels">
    <div className="context-mode"><span className={`mode-chip ${instance.mode}`}>{instance.mode}</span><strong>{instance.mode === "course" ? instance.course?.lessonTitle ?? "Course lab" : "Free playground"}</strong><p>{instance.mode === "course" ? "结构由课程 Scenario 固定；按照证据闭环完成观察、诊断与验证。" : "可调整声明式环境定义；故障操作仍由 Instance capability 决定，也不会变成真实 CUDA 设备。"}</p></div>
    {instance.mode === "course" && instance.course?.steps?.length ? <ol className="course-steps">{instance.course.steps.map((step, index) => <li className={step.complete ? "complete" : instance.course?.currentStep === index + 1 ? "current" : ""} key={step.id}><span>{step.complete ? "✓" : String(index + 1).padStart(2, "0")}</span><div><strong>{step.title}</strong>{step.command && <code>{step.command}</code>}</div></li>)}</ol> : <div className="playground-actions"><p className="section-kicker">PLAYGROUND OPERATIONS</p><button onClick={() => onNavigate("topology")}>检查分层拓扑 <span>→</span></button><button onClick={() => onNavigate("faults")}>注入受控故障 <span>→</span></button><button onClick={() => onNavigate("storage")}>查看对象存储 <span>→</span></button><button onClick={() => onNavigate("placement")}>规划模型切片 <span>→</span></button></div>}
    <nav className="context-nav">{views.map(([id, label]) => <button key={id} className={active === id ? "active" : ""} aria-current={active === id ? "page" : undefined} onClick={() => onNavigate(id)}>{label}</button>)}</nav>
  </aside>;
}

function WorkbenchPanel({ instance, view, canMutate, busy, onInject, onClear, onCheckpointCreate, onCheckpointRestore, onStorageConnect, onSymbolicLoad }: { instance: InstanceDetail; view: WorkbenchView; canMutate: boolean; busy: string; onInject(id: string, target?: string): void; onClear(id: string): void; onCheckpointCreate(name: string): void; onCheckpointRestore(id: string): void; onStorageConnect(): void; onSymbolicLoad(objectKey: string, sizeBytes?: number): void }) {
  if (view === "topology") return <TopologyPanel layers={instance.topology} />;
  if (view === "metrics") return <MetricsPanel metrics={instance.metrics} />;
  if (view === "boot") return <TimelinePanel title="Boot plan" kicker="DETERMINISTIC POST-HOC TIMELINE" events={instance.boot} empty="Runtime 没有返回启动计划；未补造 POST 或链路训练日志。" />;
  if (view === "events") return <TimelinePanel title="Runtime events" kicker="LOCAL EVENT STREAM" events={instance.events} empty="此实例尚无事件。" />;
  if (view === "faults") return <FaultPanel instance={instance} canMutate={canMutate} busy={busy} onInject={onInject} onClear={onClear} />;
  if (view === "checkpoints") return <CheckpointPanel instance={instance} canMutate={canMutate} busy={busy} onCreate={onCheckpointCreate} onRestore={onCheckpointRestore} />;
  if (view === "storage") return <StoragePanel instance={instance} canMutate={canMutate} busy={busy} onConnect={onStorageConnect} onSymbolicLoad={onSymbolicLoad} />;
  if (view === "placement") return <PlacementPanel instance={instance} />;
  return <OverviewPanel instance={instance} />;
}

function OverviewPanel({ instance }: { instance: InstanceDetail }) {
  const headline = instance.metrics.slice(0, 4);
  return <div className="panel-stack"><section className="metric-cards">{headline.length ? headline.map((metric) => <MetricCard key={metric.id} metric={metric} />) : <EmptyPanel title="没有指标快照" body="Runtime 尚未返回 metrics；这里不会生成假吞吐或利用率。" />}</section>
    <section className="panel"><PanelHeading kicker="ENVIRONMENT CONTRACT" title="当前边界" meta={instance.mode.toUpperCase()} /><dl className="definition-list"><div><dt>状态</dt><dd><span className={`status-dot ${instance.status}`}>{instance.status}</span></dd></div><div><dt>资源</dt><dd>{instance.resources.nodes} nodes · {instance.resources.accelerators} accelerators</dd></div><div><dt>Fabric</dt><dd>{instance.resources.fabric ?? "not reported"}</dd></div><div><dt>数值语义</dt><dd>bounded estimate / deterministic seed</dd></div><div><dt>真实能力</dt><dd>{instance.capabilities?.includes("terminal.attach") ? "Ubuntu Shell；不提供真实 CUDA Driver 或 GPU 性能" : instance.mode === "course" ? "课程 Sandbox 可由宿主 CLI 附加真实 Ubuntu Shell；浏览器 PTY 未连接" : "当前为 host S2 model；没有 Ubuntu Shell、CUDA Driver 或真实 GPU 性能"}</dd></div></dl></section>
    <section className="panel"><PanelHeading kicker="ACTIVE CONDITIONS" title="故障与服务" /><div className="summary-columns"><div><strong>{instance.faults.filter((fault) => fault.active).length}</strong><span>active faults</span></div><div><strong>{instance.storage.filter((service) => service.status === "ready").length}</strong><span>storage services ready</span></div><div><strong>{instance.placements.length}</strong><span>logical placements</span></div></div></section>
  </div>;
}

function MetricsPanel({ metrics }: { metrics: MetricSample[] }) {
  if (!metrics.length) return <EmptyPanel title="没有指标" body="等待 Runtime 产生首个采样；页面不会用前端随机数填充图表。" />;
  return <section className="panel"><PanelHeading kicker="MODEL OUTPUT" title="Metrics" meta="seeded / bounded" /><div className="metric-list">{metrics.map((metric) => {
    const ratio = metric.theoreticalMaximum ? Math.max(0, Math.min(100, metric.value / metric.theoreticalMaximum * 100)) : undefined;
    return <article key={metric.id}><div><strong>{metric.label}</strong><span className={metric.severity ?? "normal"}>{metric.severity ?? "normal"}</span></div><b>{formatNumber(metric.value)} <small>{metric.unit}</small></b>{ratio !== undefined && <><div className="metric-track"><i style={{ width: `${ratio}%` }} /></div><p>{ratio.toFixed(1)}% of catalog theoretical maximum</p></>}</article>;
  })}</div><p className="panel-footnote">此面板当前展示 S2 估算值；理论上限与模型假设请查看 benchmark 报告和 HardwareGraph。数据不可用于采购、容量规划或真实硬件比较。</p></section>;
}

function TimelinePanel({ title, kicker, events, empty }: { title: string; kicker: string; events: RuntimeTimelineEvent[]; empty: string }) {
  if (!events.length) return <EmptyPanel title={`没有 ${title}`} body={empty} />;
  return <section className="panel"><PanelHeading kicker={kicker} title={title} meta={`${events.length} records`} /><ol className="event-timeline">{events.map((event) => <li key={event.id} className={event.severity ?? "info"}><time>{formatDateTime(event.at)}</time><span>{event.phase ?? event.kind}</span><p>{event.message}</p></li>)}</ol></section>;
}

function FaultPanel({ instance, canMutate, busy, onInject, onClear }: { instance: InstanceDetail; canMutate: boolean; busy: string; onInject(id: string, target?: string): void; onClear(id: string): void }) {
  const [faultId, setFaultId] = useState(instance.faultCatalog?.[0]?.id ?? "");
  const selected = instance.faultCatalog?.find((fault) => fault.id === faultId);
  const [target, setTarget] = useState(selected?.allowedTargets?.[0] ?? "");
  const canInject = canMutate && isMutableInstanceStatus(instance.status) && Boolean(instance.capabilities?.includes("fault.inject"));
  const canClear = canMutate && isMutableInstanceStatus(instance.status) && Boolean(instance.capabilities?.includes("fault.clear"));
  return <div className="panel-stack"><section className="panel"><PanelHeading kicker="DECLARATIVE ACTIONS" title="Fault injection" meta="allowlisted only" />
    {instance.faultCatalog?.length ? <div className="fault-injector"><Field label="故障类型" htmlFor="fault-kind"><select id="fault-kind" value={faultId} onChange={(event) => { setFaultId(event.target.value); setTarget(instance.faultCatalog?.find((fault) => fault.id === event.target.value)?.allowedTargets?.[0] ?? ""); }}>{instance.faultCatalog.map((fault) => <option key={fault.id} value={fault.id}>{fault.label}</option>)}</select></Field><Field label="目标" htmlFor="fault-target"><input id="fault-target" list="fault-targets" value={target} onChange={(event) => setTarget(event.target.value)} /><datalist id="fault-targets">{selected?.allowedTargets?.map((item) => <option key={item} value={item} />)}</datalist></Field><button className="button danger-button" disabled={!canInject || !faultId || Boolean(busy)} title={!canInject ? "当前 Runtime 未声明 fault.inject capability" : undefined} onClick={() => onInject(faultId, target || undefined)}>注入已允许故障</button></div> : <EmptyPanel title="Scenario 没有故障 catalog" body="只有 Runtime 显式声明的 fault capability 才会出现在这里。" />}
  </section><section className="panel"><PanelHeading kicker="CURRENT STATE" title="Fault states" />{instance.faults.length ? <div className="fault-list">{instance.faults.map((fault) => <article key={fault.id}><span className={fault.active ? "active" : "cleared"}>{fault.active ? "ACTIVE" : "CLEARED"}</span><div><strong>{fault.kind}</strong><code>{fault.target}</code><p>{fault.summary}</p></div>{fault.active && <button className="button ghost compact" disabled={!canClear || Boolean(busy)} title={!canClear ? "当前 Runtime 未声明 fault.clear capability" : undefined} onClick={() => onClear(fault.id)}>Clear</button>}</article>)}</div> : <p className="empty-inline">没有已记录故障。</p>}</section></div>;
}

function CheckpointPanel({ instance, canMutate, busy, onCreate, onRestore }: { instance: InstanceDetail; canMutate: boolean; busy: string; onCreate(name: string): void; onRestore(id: string): void }) {
  const [name, setName] = useState("");
  const canCreate = canMutate && isMutableInstanceStatus(instance.status) && Boolean(instance.capabilities?.includes("checkpoint.create"));
  const canRestore = canMutate && isMutableInstanceStatus(instance.status) && Boolean(instance.capabilities?.includes("checkpoint.restore"));
  return <div className="panel-stack"><section className="panel"><PanelHeading kicker="DETERMINISTIC SAVEPOINT" title="Create checkpoint" meta="snapshot + node context" /><div className="checkpoint-create"><Field label="名称" htmlFor="checkpoint-name" hint="当前 Alpha 保存 Snapshot 引用与活动节点上下文；不包含 Workspace、token、S3 secret，也尚未保存故障/任务/Placement。"><input id="checkpoint-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="before-topology-change" /></Field><button className="button" disabled={!canCreate || !name.trim() || Boolean(busy)} title={!canCreate ? "Supervisor 未声明 checkpoint.create capability" : undefined} onClick={() => { onCreate(name.trim()); setName(""); }}>Create checkpoint</button></div></section>
    <section className="panel"><PanelHeading kicker="SAVED STATE" title="Checkpoints" meta={`${instance.checkpoints.length} saved`} />{instance.checkpoints.length ? <div className="checkpoint-list">{instance.checkpoints.map((checkpoint) => <article key={checkpoint.id}><div><span className={`checkpoint-state ${checkpoint.state}`}>{checkpoint.state}</span><h3>{checkpoint.name}</h3><p>definition rev {checkpoint.definitionRevision} · {formatDateTime(checkpoint.createdAt)}{checkpoint.sizeBytes ? ` · ${formatBytes(checkpoint.sizeBytes)}` : ""}</p>{checkpoint.compatibilityMessage && <small>{checkpoint.compatibilityMessage}</small>}</div><button className="button ghost compact" disabled={!canRestore || checkpoint.state !== "ready" || Boolean(busy)} title={!canRestore ? "Supervisor 未声明 checkpoint.restore capability" : undefined} onClick={() => onRestore(checkpoint.id)}>Restore</button></article>)}</div> : <EmptyPanel title="没有 Checkpoint" body="入口保持可见；只有 Supervisor 声明 checkpoint.create 后才可创建。当前通用 Playground Checkpoint 不包含 Workspace 文件；独立 volume 仍是计划能力。" />}</section></div>;
}

function StoragePanel({ instance, canMutate, busy, onConnect, onSymbolicLoad }: { instance: InstanceDetail; canMutate: boolean; busy: string; onConnect(): void; onSymbolicLoad(objectKey: string, sizeBytes?: number): void }) {
  const [objectKey, setObjectKey] = useState("");
  const [sizeMiB, setSizeMiB] = useState("");
  const canConnect = canMutate && Boolean(instance.capabilities?.includes("storage.connect"));
  const canLoad = canMutate && Boolean(instance.capabilities?.includes("storage.symbolic-load"));
  return <div className="panel-stack"><section className="panel"><PanelHeading kicker="OPTIONAL SERVICES" title="Object storage" meta={`${instance.storage.length} services`} />{instance.storage.length ? <div className="storage-list">{instance.storage.map((service) => <article key={service.id}><div className={`service-icon ${service.status}`}>S3</div><div><span>{service.mode}</span><h3>{service.name}</h3><p>{service.endpointLabel ?? "endpoint hidden"}</p></div><dl><div><dt>status</dt><dd>{service.status}</dd></div><div><dt>objects</dt><dd>{service.objectCount ?? "—"}</dd></div><div><dt>size</dt><dd>{service.storedBytes === undefined ? "—" : formatBytes(service.storedBytes)}</dd></div><div><dt>policy</dt><dd>{service.readOnly ? "read only" : "not reported"}</dd></div></dl></article>)}</div> : <EmptyPanel title="未配置对象存储" body="可在 Environment Builder 添加 simulated catalog；真实 S3 必须经过宿主只读 Connector，凭据不会进入 Sandbox 或定义文件。" />}
    <div className="storage-actions"><button className="button ghost" disabled={!canConnect || Boolean(busy)} title={!canConnect ? "Supervisor 未声明 storage.connect capability" : undefined} onClick={onConnect}>连接已配置 Host Connector</button><span>该操作不会在浏览器中请求 Access Key。</span></div><p className="panel-footnote">连接真实 S3 不会让 Sandbox 获得任意公网出口。所有请求必须由宿主 Connector 做 endpoint、bucket/prefix 与大小限制。</p></section>
    <section className="panel"><PanelHeading kicker="SYMBOLIC TRANSFER" title="Load model artifact" meta="no host-sized allocation" /><div className="symbolic-load"><Field label="Object key" htmlFor="object-key"><input id="object-key" value={objectKey} onChange={(event) => setObjectKey(event.target.value)} placeholder="models/llama/weights.safetensors" /></Field><Field label="Logical size (MiB, optional)" htmlFor="object-size"><input id="object-size" type="number" min="1" value={sizeMiB} onChange={(event) => setSizeMiB(event.target.value)} /></Field><button className="button" disabled={!canLoad || !objectKey.trim() || Boolean(busy)} title={!canLoad ? "Supervisor 未声明 storage.symbolic-load capability" : undefined} onClick={() => onSymbolicLoad(objectKey.trim(), sizeMiB ? numberValue(sizeMiB, 1) * 1024 * 1024 : undefined)}>Create symbolic load</button></div><p className="panel-footnote">此入口创建对象→主机缓存→逻辑 HBM 的传输事件和 Placement，不下载或分配等量宿主数据。</p></section></div>;
}

function PlacementPanel({ instance }: { instance: InstanceDetail }) {
  if (!instance.placements.length) return <EmptyPanel title="没有模型或 Tensor Placement" body="Placement 是符号容量记账，不会按虚拟 HBM 大小分配宿主内存。未来推理课程会在这里展示 shard、residency 与 transfer。" />;
  return <section className="panel"><PanelHeading kicker="SYMBOLIC MEMORY MODEL" title="Artifact placement" meta={`${instance.placements.length} artifacts`} /><div className="placement-list">{instance.placements.map((placement) => <article key={placement.id}><div><span className={`placement-state ${placement.state ?? "planned"}`}>{placement.state ?? "planned"}</span><h3>{placement.artifact}</h3><p>{placement.strategy}</p></div><strong>{placement.sizeBytes ? formatBytes(placement.sizeBytes) : "logical size unavailable"}</strong><div className="target-chips">{placement.targets.map((target) => <code key={target}>{target}</code>)}</div></article>)}</div></section>;
}

function SystemPage({ mode, data, directSnapshot }: { mode: ConnectionMode; data: BootstrapData; directSnapshot?: SimulationSnapshot | undefined }) {
  return <div className="page-stack"><PageHeader eyebrow="SYSTEM & BOUNDARIES" title="Local control plane" description="InfraEnv 是单用户、本机教育模拟器，不是多租户集群管理系统。" /><div className="system-grid"><section className="panel"><PanelHeading kicker="CONNECTION" title="Active endpoint" /><dl className="definition-list"><div><dt>mode</dt><dd>{mode}</dd></div><div><dt>API</dt><dd>{data.status.apiVersion}</dd></div><div><dt>Runtime</dt><dd>{data.status.runtimeVersion ?? "not reported"}</dd></div><div><dt>Binding</dt><dd>expected 127.0.0.1 only</dd></div>{directSnapshot && <div><dt>Scenario</dt><dd>{directSnapshot.scenarioId}@{directSnapshot.scenarioVersion}</dd></div>}</dl></section><section className="panel"><PanelHeading kicker="SECURITY" title="Non-negotiable boundaries" /><ul className="boundary-list"><li>Browser 不获得 Docker Socket 或 Supervisor bearer token。</li><li>已接通的课程 Sandbox 不挂载宿主目录，默认无公网出口。</li><li>浏览器 Terminal 只有在 Supervisor 明确广告一次性 ticket 能力后才启用；当前保持禁用。</li><li>真实 S3 Connector 尚未接入；未来凭据只能由宿主 Credential Store 与 signer 边界持有。</li><li>所有模拟命令持续展示 SIMULATED / S2。</li></ul></section><section className="panel"><PanelHeading kicker="DOCUMENTATION" title="Manual" /><p className="body-copy">仓库 <code>docs/</code> 包含用户手册、Environment Definition、Web UI/API 契约、开发说明与架构决策记录。</p></section></div></div>;
}

function PageHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: React.ReactNode }) {
  return <header className="page-header"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{actions && <div className="page-actions">{actions}</div>}</header>;
}

function SectionHeader({ id, title, meta }: { id: string; title: string; meta: string }) { return <header className="section-header"><h2 id={id}>{title}</h2><span>{meta}</span></header>; }
function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: React.ReactNode }) { return <label className="field" htmlFor={htmlFor}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
function ResourceStrip({ resources, compact = false }: { resources: EnvironmentSummary["resources"]; compact?: boolean }) { return <div className={`resource-strip ${compact ? "compact" : ""}`}><span><b>{resources.racks}</b> racks</span><span><b>{resources.nodes}</b> nodes</span><span><b>{resources.accelerators}</b> accelerators</span>{!compact && <span><b>{resources.fabric ?? "—"}</b> fabric</span>}</div>; }
function MetricCard({ metric }: { metric: MetricSample }) { return <article className={`metric-card ${metric.severity ?? "normal"}`}><p>{metric.label}</p><strong>{formatNumber(metric.value)}</strong><span>{metric.unit}</span>{metric.theoreticalMaximum !== undefined && <small>theoretical max {formatNumber(metric.theoreticalMaximum)}</small>}</article>; }

function parseRoute(): Route {
  const value = window.location.hash.replace(/^#\/?/, "");
  if (!value || value.startsWith("launchToken=")) return { page: "environments" };
  const [path, query = ""] = value.split("?");
  const parts = path?.split("/").filter(Boolean) ?? [];
  const page = parts[0] as Page;
  if (!["environments", "builder", "instances", "workbench", "about"].includes(page)) return { page: "environments" };
  const params = new URLSearchParams(query);
  const preset = params.get("preset");
  return { page, ...(parts[1] && parts[1] !== "new" ? { id: decodeURIComponent(parts[1]) } : {}), ...(preset ? { preset } : {}), ...(parts[2] ? { view: parts[2] as WorkbenchView } : {}) };
}

function routeHash(route: Route): string {
  const id = route.id ? `/${encodeURIComponent(route.id)}` : route.page === "builder" ? "/new" : "";
  const view = route.page === "workbench" && route.view ? `/${route.view}` : "";
  const query = route.preset ? `?preset=${encodeURIComponent(route.preset)}` : "";
  return `#/${route.page}${id}${view}${query}`;
}

function preferredTheme(): "light" | "dark" {
  const stored = window.localStorage.getItem("infraenv-theme");
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function runningInstanceId(instances: InstanceSummary[]): string | undefined { return instances.find((instance) => isReadyStatus(instance.status) || instance.status === "paused")?.id ?? instances[0]?.id; }
function isReadyStatus(status: InstanceSummary["status"]): boolean { return status === "ready" || status === "running"; }
function isMutableInstanceStatus(status: InstanceSummary["status"]): boolean { return isReadyStatus(status) || status === "paused"; }
function isTerminalInstanceStatus(status: InstanceSummary["status"]): boolean { return status === "stopped" || status === "failed" || status === "error"; }
function numberValue(value: string, fallback: number): number { const parsed = Number.parseInt(value, 10); return Number.isFinite(parsed) ? parsed : fallback; }
function formatDate(value?: string): string { return value ? new Date(value).toLocaleDateString() : "not reported"; }
function formatDateTime(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString(); }
function formatNumber(value: number): string { return Math.abs(value) >= 1_000 ? value.toLocaleString(undefined, { maximumFractionDigits: 1 }) : value.toLocaleString(undefined, { maximumFractionDigits: 2 }); }
function formatBytes(value: number): string { const units = ["B", "KiB", "MiB", "GiB", "TiB"]; let amount = value; let index = 0; while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; } return `${amount.toFixed(amount >= 10 || index === 0 ? 0 : 1)} ${units[index]}`; }

function draftFromPreset(preset?: PresetSummary): EnvironmentDraft {
  if (!preset) return structuredClone(EMPTY_DRAFT);
  const racks = Math.max(1, preset.resources.racks);
  const nodesPerRack = Math.max(1, Math.ceil(preset.resources.nodes / racks));
  const acceleratorsPerNode = Math.max(0, Math.ceil(preset.resources.accelerators / Math.max(1, preset.resources.nodes)));
  return {
    ...structuredClone(EMPTY_DRAFT),
    name: `${preset.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-playground`,
    description: `DERIVED / CUSTOM from ${preset.name} ${preset.version}; the editable result is not the immutable reference Preset.`,
    source: { kind: "template", templateId: preset.id, version: preset.version },
    inventory: preset.suggestedDraft?.inventory ?? { rackCount: racks, nodesPerRack, acceleratorsPerNode, acceleratorModel: preset.resources.acceleratorModel ?? EMPTY_DRAFT.inventory.acceleratorModel },
    topology: preset.suggestedDraft?.topology ?? { ...EMPTY_DRAFT.topology, interRack: preset.resources.fabric?.toLowerCase().includes("rail") ? "rail-optimized" : "fat-tree" }
  };
}

function adaptDirectRuntime(snapshot: SimulationSnapshot): { bootstrap: BootstrapData; detail: InstanceDetail } {
  const accelerators = snapshot.nodes.reduce((sum, node) => sum + node.gpus.length, 0);
  const acceleratorModel = snapshot.nodes[0]?.gpus[0]?.model;
  const resources = { racks: 1, nodes: snapshot.nodes.length, accelerators, ...(acceleratorModel ? { acceleratorModel } : {}), fabric: "Scenario-defined" };
  const environment: EnvironmentSummary = { id: `direct:${snapshot.scenarioId}`, name: snapshot.scenarioId.replace(/^scenario:/, ""), description: "当前课程 Runtime 的只读投影。Supervisor 未连接。", mode: "course", revision: 1, sourceLabel: `${snapshot.scenarioId}@${snapshot.scenarioVersion}`, resources, activeInstanceId: snapshot.sessionId };
  const instance: InstanceSummary = { id: snapshot.sessionId, environmentId: environment.id, environmentName: environment.name, mode: "course", status: snapshot.status === "running" || snapshot.status === "passed" ? "ready" : snapshot.status, definitionRevision: 1, apiReady: true, resources };
  const topology = [{ id: "cluster:direct", label: environment.name, kind: "cluster" as const, count: 1, health: snapshot.nodes.some((node) => node.health === "degraded") ? "degraded" as const : "healthy" as const, children: snapshot.nodes.map((node) => ({ id: node.id, label: node.id, kind: "node" as const, count: 1, health: node.health, bandwidth: `${node.network.bandwidthGbps} Gbps`, latency: `${node.network.latencyMs} ms`, children: [{ id: `${node.id}:gpus`, label: acceleratorModel ?? "SIMULATED GPU", kind: "accelerator" as const, count: node.gpus.length, health: node.health }] })) }];
  const metrics: MetricSample[] = [
    { id: "training.step_time", label: "Step time", value: snapshot.training.stepTimeMs, unit: "ms", severity: snapshot.training.stepTimeMs > 200 ? "warning" : "normal" },
    { id: "training.throughput", label: "Throughput", value: snapshot.training.throughputSamplesPerSecond, unit: "samples/s" },
    { id: "training.collective", label: "Collective time", value: snapshot.training.collectiveTimeMs, unit: "ms", severity: snapshot.training.collectiveTimeMs > 100 ? "warning" : "normal" },
    { id: "training.sync_wait", label: "Synchronization wait", value: snapshot.training.synchronizationWaitMs, unit: "ms", severity: snapshot.training.synchronizationWaitMs > 100 ? "warning" : "normal" }
  ];
  const steps = deriveDirectCourseSteps(snapshot);
  const firstIncomplete = steps.findIndex((step) => !step.complete);
  const faultCatalog = snapshot.faults.map((fault) => ({ id: fault.id, kind: fault.type, label: `Scenario fault · ${fault.type}`, allowedTargets: [fault.target] }));
  const detail: InstanceDetail = {
    ...instance,
    disclosure: snapshot.disclosure,
    virtualTimeSeconds: snapshot.virtualTimeSeconds,
    topology,
    metrics,
    boot: [],
    events: [],
    faults: snapshot.faults.map((fault) => ({ id: fault.id, kind: fault.type, target: fault.target, active: fault.active })),
    faultCatalog,
    storage: [],
    placements: [],
    checkpoints: [],
    course: { courseTitle: "AI Infrastructure Operations", chapterTitle: "Distributed Training Diagnostics", lessonTitle: "Find a Slow Worker", currentStep: firstIncomplete < 0 ? steps.length : firstIncomplete + 1, totalSteps: steps.length, steps },
    capabilities: deriveDirectRuntimeCapabilities(snapshot.allowedUiActions)
  };
  return { bootstrap: { status: { apiVersion: "direct-runtime-v1" }, environments: [environment], presets: [], instances: [instance], trash: [] }, detail };
}
