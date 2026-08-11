import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { createTerminalTicket, terminalWebSocket } from "./api.js";

type TerminalStatus = "idle" | "connecting" | "connected" | "closed" | "error";

interface TerminalPanelProps {
  instanceId?: string;
  enabled: boolean;
  unavailableReason?: string;
}

export function TerminalPanel({ instanceId, enabled, unavailableReason }: TerminalPanelProps) {
  const [status, setStatus] = useState<TerminalStatus>("idle");
  const [chunks, setChunks] = useState<string[]>([]);
  const [command, setCommand] = useState("");
  const [error, setError] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const outputRef = useRef<HTMLPreElement>(null);

  useEffect(() => () => socketRef.current?.close(1000, "view closed"), []);
  useEffect(() => {
    socketRef.current?.close(1000, "instance changed");
    socketRef.current = null;
    setStatus("idle");
    setChunks([]);
    setError("");
  }, [instanceId]);
  useEffect(() => {
    const output = outputRef.current;
    if (output) output.scrollTop = output.scrollHeight;
  }, [chunks]);

  const attach = async () => {
    if (!instanceId || !enabled) return;
    setStatus("connecting");
    setError("");
    try {
      const ticket = await createTerminalTicket(instanceId);
      const socket = terminalWebSocket(ticket);
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        setStatus("connected");
        socket.send(JSON.stringify({ type: "resize", cols: 96, rows: 28 }));
      });
      socket.addEventListener("message", (event) => {
        const raw = typeof event.data === "string" ? event.data : "[binary terminal frame]";
        let value = raw;
        try {
          const frame = JSON.parse(raw) as { type?: string; data?: string; message?: string };
          value = frame.data ?? frame.message ?? raw;
        } catch {
          // Plain text frames are valid terminal output.
        }
        setChunks((current) => [...current, value].slice(-400));
      });
      socket.addEventListener("close", () => setStatus("closed"));
      socket.addEventListener("error", () => {
        setError("Terminal 通道建立失败；实例仍可从宿主 CLI 附加。");
        setStatus("error");
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法获取一次性 Terminal ticket。");
      setStatus("error");
    }
  };

  const send = (event: FormEvent) => {
    event.preventDefault();
    const socket = socketRef.current;
    if (!command.trim() || !socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "input", data: `${command}\r` }));
    setCommand("");
  };

  const disconnect = () => socketRef.current?.close(1000, "user detached");

  return (
    <section className="terminal-panel" aria-labelledby="terminal-heading">
      <header className="terminal-toolbar">
        <div>
          <p className="section-kicker">{enabled ? "REAL UBUNTU SHELL" : "CAPABILITY-GATED · NOT CONNECTED"}</p>
          <h2 id="terminal-heading">Terminal</h2>
        </div>
        <span className={`terminal-state ${status}`} aria-live="polite">{enabled ? terminalStatusLabel(status) : "UNAVAILABLE"}</span>
        {status === "connected"
          ? <button className="button ghost compact" type="button" onClick={disconnect}>Detach</button>
          : <button className="button compact" type="button" disabled={!enabled || !instanceId || status === "connecting"} onClick={() => void attach()}>Attach</button>}
      </header>
      <div className="terminal-disclosure">{enabled
        ? "SIMULATED / S2 · GPU、互联与调度状态为模型输出；Shell 是真实 Ubuntu。"
        : "SIMULATED / S2 · 当前 Instance 未声明 terminal.attach；这里没有 Ubuntu Shell，也不会创建 PTY。"}</div>
      <pre ref={outputRef} className="terminal-output" tabIndex={0} aria-label="Terminal output" aria-live="polite">
        {chunks.length ? chunks.join("") : terminalEmptyText(enabled, unavailableReason)}
      </pre>
      <form className="terminal-input" onSubmit={send}>
        <label htmlFor="terminal-command">命令</label>
        <span aria-hidden="true">$</span>
        <input
          id="terminal-command"
          autoComplete="off"
          spellCheck={false}
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          disabled={status !== "connected"}
          placeholder={status === "connected" ? "输入命令并回车" : "Attach 后可输入"}
        />
      </form>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <p className="terminal-footnote">{enabled
        ? "启用后浏览器只接收一次性 PTY ticket；不会获得 Runtime bearer token 或 Docker Socket。"
        : "一次性 PTY ticket 是目标安全契约；当前 Supervisor 不会签发该 capability。"}</p>
    </section>
  );
}

function terminalStatusLabel(status: TerminalStatus): string {
  if (status === "connecting") return "CONNECTING";
  if (status === "connected") return "ATTACHED";
  if (status === "closed") return "DETACHED";
  if (status === "error") return "ERROR";
  return "NOT ATTACHED";
}

function terminalEmptyText(enabled: boolean, reason?: string): string {
  if (!enabled) return `${reason ?? "Terminal 需要运行中的 Supervisor 实例。"}\n\n未建立 PTY，也没有执行任何命令。`;
  return "Terminal 尚未附加。点击 Attach 后才会连接当前 Instance 已提供的 Sandbox PTY。\n\n建议先运行：nvidia-smi -L\nnvidia-smi topo -m\ninfraenv topology";
}
