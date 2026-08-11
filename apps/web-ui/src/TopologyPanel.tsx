import type { TopologyLayer } from "./types.js";

export function TopologyPanel({ layers }: { layers: TopologyLayer[] }) {
  if (!layers.length) return <EmptyPanel title="尚无拓扑快照" body="实例没有返回 inventory/topology 数据。InfraEnv 不会为离线环境生成虚假的设备或链路。" />;
  return (
    <section className="panel topology-panel" aria-labelledby="topology-title">
      <PanelHeading kicker="HIERARCHICAL AGGREGATION" title="分层拓扑" meta={`${countKind(layers, "accelerator")} accelerators`} id="topology-title" />
      <div className="topology-legend" aria-label="Topology legend">
        <span><i className="healthy" />healthy</span><span><i className="degraded" />degraded</span><span><i className="offline" />offline</span>
      </div>
      <div className="topology-tree">
        {layers.map((layer) => <TopologyBranch key={layer.id} layer={layer} depth={0} />)}
      </div>
    </section>
  );
}

function TopologyBranch({ layer, depth }: { layer: TopologyLayer; depth: number }) {
  const children = layer.children ?? [];
  const visible = children.slice(0, 8);
  const summary = `${layer.count} ${layer.kind}${layer.count === 1 ? "" : "s"}`;
  if (!children.length) {
    return <article className={`topology-leaf ${layer.health ?? "unknown"}`} style={{ "--depth": depth } as React.CSSProperties}>
      <span className="topology-kind">{layer.kind}</span><strong>{layer.label}</strong><small>{summary}</small>
      {(layer.bandwidth || layer.latency) && <em>{[layer.bandwidth, layer.latency].filter(Boolean).join(" · ")}</em>}
    </article>;
  }
  return (
    <details className={`topology-branch ${layer.health ?? "unknown"}`} open={depth < 2}>
      <summary>
        <span className="topology-kind">{layer.kind}</span>
        <strong>{layer.label}</strong>
        <small>{summary}</small>
        {(layer.bandwidth || layer.latency) && <em>{[layer.bandwidth, layer.latency].filter(Boolean).join(" · ")}</em>}
      </summary>
      <div className="topology-children">
        {visible.map((child) => <TopologyBranch key={child.id} layer={child} depth={depth + 1} />)}
        {children.length > visible.length && <div className="topology-overflow">+ {children.length - visible.length} 个同层对象已聚合；使用 CLI 或 JSON 视图查看完整列表。</div>}
      </div>
    </details>
  );
}

function countKind(layers: TopologyLayer[], kind: TopologyLayer["kind"]): number {
  return layers.reduce((sum, layer) => sum + (layer.kind === kind ? layer.count : 0) + countKind(layer.children ?? [], kind), 0);
}

export function PanelHeading({ kicker, title, meta, id }: { kicker: string; title: string; meta?: string; id?: string }) {
  return <header className="panel-heading"><div><p className="section-kicker">{kicker}</p><h2 id={id}>{title}</h2></div>{meta && <span>{meta}</span>}</header>;
}

export function EmptyPanel({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return <section className="empty-panel"><span aria-hidden="true">∅</span><h2>{title}</h2><p>{body}</p>{action}</section>;
}
