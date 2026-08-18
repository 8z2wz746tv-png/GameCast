import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Copy,
  DoorOpen,
  Eye,
  FileDown,
  Gauge,
  Link2,
  LoaderCircle,
  LogOut,
  Maximize2,
  MonitorUp,
  Network,
  Palette,
  Radio,
  RotateCw,
  Server,
  Settings2,
  ShieldCheck,
  TriangleAlert,
  Volume2,
  WifiOff,
  X,
} from "lucide-react";
import type { RoomLimits, RoomSession } from "@gamecast/contracts";
import {
  api,
  configureApiBaseUrl,
  getApiBaseUrl,
  getPublicControlServerUrl,
} from "./api";
import { VIDEO_PRESETS } from "./media";
import { useRoomMedia } from "./use-room-media";
import { diagnosticLog, errorDetails } from "./diagnostics";
import { formatRoomInvitation, parseRoomInvitation } from "./room-invitation";
import { isPrivateControlServerUrl } from "./server-address";
import type {
  CaptureSource,
  HostSettingsInput,
  HostSettingsStatus,
  NetworkInterfaceCandidate,
} from "./vite-env";

type EntryMode = "create" | "join";
type HostingMode = "local" | "internet";
type ActiveSession = { session: RoomSession; localHost: boolean };
type RoomNotice = { tone: "success" | "info" | "error"; message: string };
type ThemeId = "oasis" | "aurora" | "amber" | "rose";

const THEMES: Array<{ id: ThemeId; label: string; color: string }> = [
  { id: "oasis", label: "绿洲", color: "#61e3a2" },
  { id: "aurora", label: "极光", color: "#55c7ff" },
  { id: "amber", label: "琥珀", color: "#f4c55c" },
  { id: "rose", label: "玫瑰", color: "#ff7997" },
];

const DEFAULT_LIMITS: RoomLimits = {
  maxParticipants: 8,
  maxSharers: 4,
  maxViewersPerShare: 3,
};

export function App() {
  const [active, setActive] = useState<ActiveSession | null>(null);
  const [theme, setTheme] = useState<ThemeId>(() => {
    const saved = localStorage.getItem("gamecast.theme");
    return THEMES.some((candidate) => candidate.id === saved) ? saved as ThemeId : "oasis";
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("gamecast.theme", theme);
  }, [theme]);

  return active ? (
    <RoomView
      session={active.session}
      localHost={active.localHost}
      onLeave={() => setActive(null)}
      theme={theme}
      onThemeChange={setTheme}
    />
  ) : (
    <EntryView
      onSession={(session, localHost) => setActive({ session, localHost })}
      theme={theme}
      onThemeChange={setTheme}
    />
  );
}

function EntryView({
  onSession,
  theme,
  onThemeChange,
}: {
  onSession: (session: RoomSession, localHost: boolean) => void;
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
}) {
  const [mode, setMode] = useState<EntryMode>("create");
  const publicServerUrl = getPublicControlServerUrl();
  const [hostingMode, setHostingMode] = useState<HostingMode>("internet");
  const [title, setTitle] = useState("今晚一起玩");
  const [displayName, setDisplayName] = useState(
    () => localStorage.getItem("gamecast.displayName") ?? "",
  );
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [serverUrl, setServerUrl] = useState(
    () => {
      const saved = localStorage.getItem("gamecast.serverUrl");
      return saved && (!publicServerUrl || !isPrivateControlServerUrl(saved))
        ? saved
        : publicServerUrl ?? saved ?? getApiBaseUrl();
    },
  );
  const [limits, setLimits] = useState<RoomLimits>(DEFAULT_LIMITS);
  const [networks, setNetworks] = useState<NetworkInterfaceCandidate[]>([]);
  const [selectedNetwork, setSelectedNetwork] = useState("");
  const [hostSettings, setHostSettings] = useState<HostSettingsStatus>();
  const [settingsInput, setSettingsInput] = useState<HostSettingsInput>({
    turnUrls: "",
    livekitServerUrl: "",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [invitationRecognized, setInvitationRecognized] = useState(false);

  useEffect(() => {
    if (!window.electronAPI) return;
    Promise.all([
      window.electronAPI.listNetworkInterfaces(),
      window.electronAPI.getHostSettings(),
    ]).then(([nextNetworks, settings]) => {
      setNetworks(nextNetworks);
      const preferred = nextNetworks.find((network) => network.recommended) ?? nextNetworks[0];
      setSelectedNetwork(preferred?.address ?? "");
      setHostSettings(settings);
      setSettingsInput({
        turnUrls: settings.turnUrls,
        livekitServerUrl: settings.livekitServerUrl,
      });
    });
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    let localHostStarted = false;
    try {
      diagnosticLog("entry", "submit.requested", {
        mode,
        hostingMode,
        serverUrl,
        hasInvitation: Boolean(code),
      });
      let effectiveServerUrl = serverUrl;
      if (mode === "create" && hostingMode === "local") {
        if (!window.electronAPI) throw new Error("本机房主模式只能在 Windows 客户端中使用");
        if (!selectedNetwork) throw new Error("没有找到可用的虚拟局域网地址");
        await window.electronAPI.saveHostSettings(settingsInput);
        const hosted = await window.electronAPI.startHostServer(selectedNetwork);
        localHostStarted = true;
        effectiveServerUrl = hosted.serverUrl;
      }

      if (mode === "create" && hostingMode === "internet" && isPrivateControlServerUrl(effectiveServerUrl)) {
        throw new Error("互联网房间不能使用 192.168.x.x、10.x.x.x 或 100.64.x.x 地址，请填写公网控制节点；局域网地址请切换到本机房主。\n");
      }

      configureApiBaseUrl(effectiveServerUrl);
      const health = await api.health();
      diagnosticLog("entry", "control-node.ready", {
        serverUrl: effectiveServerUrl,
        deploymentMode: health.deploymentMode,
        turnAvailable: health.turnAvailable,
        sfuAvailable: health.sfuAvailable,
        sfuViewerThreshold: health.sfuViewerThreshold,
      });
      localStorage.setItem("gamecast.serverUrl", effectiveServerUrl.trim());
      localStorage.setItem("gamecast.displayName", displayName.trim());
      const session =
        mode === "create"
          ? await api.createRoom({
              title,
              displayName,
              password: password || undefined,
              mediaMode: "hybrid",
              limits,
            })
          : await api.joinRoom(code, {
              displayName,
              password: password || undefined,
            });
      onSession(session, localHostStarted);
    } catch (submitError) {
      if (localHostStarted) await window.electronAPI?.stopHostServer().catch(() => undefined);
      diagnosticLog("entry", "submit.failed", errorDetails(submitError), "error");
      setError(submitError instanceof Error ? submitError.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  const selectedNetworkInfo = networks.find((network) => network.address === selectedNetwork);

  function applyInvitation(value: string): boolean {
    const invitation = parseRoomInvitation(value);
    if (!invitation) return false;
    setServerUrl(invitation.serverUrl);
    setCode(invitation.code);
    setMode("join");
    setInvitationRecognized(true);
    setError("");
    return true;
  }

  function handleServerPaste(event: React.ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData("text");
    if (applyInvitation(pasted)) event.preventDefault();
  }

  function handleServerChange(value: string) {
    if (applyInvitation(value)) return;
    setServerUrl(value);
    setInvitationRecognized(false);
  }

  return (
    <main className="entry-shell">
      <section className="entry-intro">
        <div className="brand-mark"><Radio size={20} strokeWidth={2.5} /></div>
        <p className="eyebrow">GAMECAST</p>
        <h1>把这一局，清楚地分享给朋友。</h1>
        <p className="intro-copy">建个房间，叫上固定队。选择一个共享画面，专心看、及时聊。</p>
        <div className="trust-line"><ShieldCheck size={16} /> 连接由你掌控 · P2P 优先 · 支持自托管</div>
      </section>

      <section className="entry-panel wide">
        <div className="entry-tools"><ThemePicker theme={theme} onChange={onThemeChange} /></div>
        <div className="segmented-control" role="tablist" aria-label="房间操作">
          <button className={mode === "create" ? "active" : ""} onClick={() => setMode("create")} type="button">创建房间</button>
          <button className={mode === "join" ? "active" : ""} onClick={() => setMode("join")} type="button">加入房间</button>
        </div>

        <form className="entry-form" onSubmit={submit}>
          {mode === "create" && window.electronAPI && (
            <div className="hosting-choice">
              <button type="button" className={hostingMode === "local" ? "active" : ""} onClick={() => setHostingMode("local")}><Network size={16} />本机房主</button>
              <button type="button" className={hostingMode === "internet" ? "active" : ""} onClick={() => setHostingMode("internet")}><Server size={16} />互联网节点</button>
            </div>
          )}

          {(mode === "join" || hostingMode === "internet") && (
            <label>
              <span><Server size={14} />服务器地址</span>
              <input value={serverUrl} onChange={(event) => handleServerChange(event.target.value)} onPaste={handleServerPaste} placeholder="粘贴邀请信息或输入服务器地址" required />
              {invitationRecognized && <small className="field-success"><Check size={13} />已识别邀请，服务器地址和房间口令已自动填写</small>}
              {mode === "create" && hostingMode === "internet" && isPrivateControlServerUrl(serverUrl) && <small className="field-warning">当前是私网地址，异地朋友无法访问。请填写公网控制节点地址。</small>}
            </label>
          )}

          {mode === "create" && hostingMode === "local" && (
            <label>
              <span><Network size={14} />虚拟局域网地址</span>
              <div className="select-field">
                <select value={selectedNetwork} onChange={(event) => setSelectedNetwork(event.target.value)} required>
                  {networks.map((network) => (
                    <option key={network.id} value={network.address}>
                      {network.name} · {network.address}{network.recommended ? " · 推荐" : ""}
                    </option>
                  ))}
                </select>
                <ChevronDown size={15} />
              </div>
              {selectedNetworkInfo && !selectedNetworkInfo.recommended && <small className="field-warning">当前网卡未识别为 Tailscale、ZeroTier 或 WireGuard，请确认朋友能够访问该地址。</small>}
            </label>
          )}

          {mode === "create" ? (
            <label>
              <span>房间名称</span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={64} placeholder="例如：周末开黑" required />
            </label>
          ) : (
            <label>
              <span>房间口令</span>
              <input className="code-input" value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} maxLength={6} placeholder="6 位口令" required />
            </label>
          )}

          <label>
            <span>你的昵称</span>
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={32} placeholder="在房间里显示的名称" required />
          </label>
          <label>
            <span>房间密码 <small>可选</small></span>
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} maxLength={128} placeholder="留空表示无需密码" />
          </label>

          {mode === "create" && (
            <div className="limit-grid">
              <NumberSetting label="总人数" value={limits.maxParticipants} min={2} max={8} onChange={(value) => setLimits((current) => ({ ...current, maxParticipants: value, maxSharers: Math.min(current.maxSharers, value), maxViewersPerShare: Math.min(current.maxViewersPerShare, value - 1) }))} />
              <NumberSetting label="共享者" value={limits.maxSharers} min={1} max={Math.min(4, limits.maxParticipants)} onChange={(value) => setLimits((current) => ({ ...current, maxSharers: value }))} />
              <NumberSetting label="每路观众" value={limits.maxViewersPerShare} min={1} max={Math.min(7, limits.maxParticipants - 1)} onChange={(value) => setLimits((current) => ({ ...current, maxViewersPerShare: value }))} />
            </div>
          )}

          {mode === "create" && hostingMode === "local" && (
            <details className="advanced-settings">
              <summary><Settings2 size={15} />可选中转与 SFU</summary>
              <label><span>STUN/TURN 地址 <small>逗号分隔</small></span><input value={settingsInput.turnUrls} onChange={(event) => setSettingsInput((current) => ({ ...current, turnUrls: event.target.value }))} placeholder="turn:host:3478?transport=udp" /></label>
              <label><span>TURN 共享密钥 {hostSettings?.hasTurnSecret && <small>已保存，留空保持不变</small>}</span><input type="password" value={settingsInput.turnSharedSecret ?? ""} onChange={(event) => setSettingsInput((current) => ({ ...current, turnSharedSecret: event.target.value }))} /></label>
              <label><span>LiveKit WebSocket 地址</span><input value={settingsInput.livekitServerUrl} onChange={(event) => setSettingsInput((current) => ({ ...current, livekitServerUrl: event.target.value }))} placeholder="wss://livekit.example.com" /></label>
              <div className="secret-grid">
                <label><span>LiveKit API Key</span><input type="password" value={settingsInput.livekitApiKey ?? ""} onChange={(event) => setSettingsInput((current) => ({ ...current, livekitApiKey: event.target.value }))} placeholder={hostSettings?.hasLivekitCredentials ? "已保存" : ""} /></label>
                <label><span>LiveKit API Secret</span><input type="password" value={settingsInput.livekitApiSecret ?? ""} onChange={(event) => setSettingsInput((current) => ({ ...current, livekitApiSecret: event.target.value }))} placeholder={hostSettings?.hasLivekitCredentials ? "已保存" : ""} /></label>
              </div>
            </details>
          )}

          {error && <div className="form-error">{error}</div>}
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={18} /> : mode === "create" ? <DoorOpen size={18} /> : <Link2 size={18} />}
            {busy ? "正在连接" : mode === "create" ? "创建并进入" : "加入房间"}
          </button>
        </form>
        <DiagnosticsButton label />
      </section>
    </main>
  );
}

function ThemePicker({ theme, onChange }: { theme: ThemeId; onChange: (theme: ThemeId) => void }) {
  return (
    <details className="theme-menu">
      <summary className="icon-button" title="切换主题色" aria-label="切换主题色"><Palette size={17} /></summary>
      <div className="theme-options" role="menu" aria-label="主题色">
        {THEMES.map((candidate) => (
          <button
            className={theme === candidate.id ? "active" : ""}
            type="button"
            role="menuitemradio"
            aria-checked={theme === candidate.id}
            key={candidate.id}
            onClick={(event) => {
              onChange(candidate.id);
              event.currentTarget.closest("details")?.removeAttribute("open");
            }}
          >
            <span className="theme-swatch" style={{ backgroundColor: candidate.color }} />
            <span>{candidate.label}</span>
            {theme === candidate.id && <Check size={14} />}
          </button>
        ))}
      </div>
    </details>
  );
}

function NumberSetting({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  return <label><span>{label}</span><input type="number" value={value} min={min} max={max} onChange={(event) => onChange(Math.max(min, Math.min(max, Number(event.target.value))))} /></label>;
}

function DiagnosticsButton({ label = false }: { label?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const electronAPI = window.electronAPI;
  if (!electronAPI) return null;

  async function exportDiagnostics() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    diagnosticLog("diagnostics", "export.clicked");
    try {
      const result = await electronAPI!.exportDiagnostics();
      setMessage("诊断包已保存到桌面");
      diagnosticLog("diagnostics", "export.completed", { fileName: result.path.split(/[\\/]/).pop() });
    } catch (error) {
      const details = errorDetails(error);
      diagnosticLog("diagnostics", "export.failed", details, "error");
      setMessage("导出失败，请重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`diagnostics-control ${label ? "with-label" : ""}`}>
      <button
        className={label ? "quiet-button" : "icon-button"}
        title="导出诊断包"
        aria-label="导出诊断包"
        onClick={() => void exportDiagnostics()}
        disabled={busy}
        type="button"
      >
        {busy ? <LoaderCircle className="spin" size={16} /> : <FileDown size={16} />}
        {label && (busy ? "正在导出" : "导出诊断包")}
      </button>
      {message && <small>{message}</small>}
    </div>
  );
}

function RoomView({ session, localHost, onLeave, theme, onThemeChange }: { session: RoomSession; localHost: boolean; onLeave: () => void; theme: ThemeId; onThemeChange: (theme: ThemeId) => void }) {
  const live = useRoomMedia(session);
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [showSourcePicker, setShowSourcePicker] = useState(false);
  const [showLeaveDialog, setShowLeaveDialog] = useState(false);
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [presetName, setPresetName] = useState("1080p");
  const [shareError, setShareError] = useState("");
  const [shareStarting, setShareStarting] = useState(false);
  const [shareStopping, setShareStopping] = useState(false);
  const [presetChanging, setPresetChanging] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [notice, setNotice] = useState<RoomNotice | null>(null);
  const shareStartingRef = useRef(false);
  const noticeTimerRef = useRef<number | undefined>(undefined);
  const preset = useMemo(
    () => VIDEO_PRESETS.find((item) => item.name === presetName) ?? VIDEO_PRESETS[2]!,
    [presetName],
  );

  function showNotice(message: string, tone: RoomNotice["tone"] = "success") {
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    setNotice({ message, tone });
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 2600);
  }

  useEffect(() => () => {
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
  }, []);

  useEffect(() => {
    if (!showSourcePicker) {
      setSources([]);
      setSelectedSourceId("");
      return;
    }
    let active = true;
    setSourcesLoading(true);
    setShareError("");
    if (!window.electronAPI) {
      setSources([{ id: "browser", name: "系统选择器", thumbnail: "" }]);
      setSelectedSourceId("browser");
      setSourcesLoading(false);
      return () => { active = false; };
    }
    window.electronAPI.listCaptureSources()
      .then((nextSources) => {
        if (!active) return;
        setSources(nextSources);
        setSelectedSourceId((current) => current || nextSources[0]?.id || "");
      })
      .catch(() => active && setShareError("无法读取桌面窗口，请重新打开选择器"))
      .finally(() => active && setSourcesLoading(false));
    return () => { active = false; };
  }, [showSourcePicker]);

  async function confirmShare() {
    if (!selectedSourceId || shareStartingRef.current) return;
    shareStartingRef.current = true;
    setShareStarting(true);
    try {
      setShareError("");
      await live.startSharing(selectedSourceId, preset);
      setShowSourcePicker(false);
      showNotice(`屏幕共享已开始 · ${preset.label} / 60fps`);
    } catch (error) {
      setShareError(error instanceof Error ? error.message : "无法开始共享");
    } finally {
      shareStartingRef.current = false;
      setShareStarting(false);
    }
  }

  async function stopShare() {
    if (shareStopping) return;
    setShareStopping(true);
    try {
      await live.stopSharing();
      showNotice("屏幕共享已停止", "info");
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "停止共享失败", "error");
    } finally {
      setShareStopping(false);
    }
  }

  async function changePreset(nextName: string) {
    setPresetName(nextName);
    const nextPreset = VIDEO_PRESETS.find((item) => item.name === nextName);
    if (!nextPreset) return;
    setPresetChanging(true);
    try {
      await live.updateSharePreset(nextPreset);
      if (live.isSharing) showNotice(`画质上限已切换为 ${nextPreset.label} / 60fps`, "info");
    } catch {
      showNotice("切换画质失败，请重试", "error");
    } finally {
      setPresetChanging(false);
    }
  }

  async function copyText(value: string, successMessage: string) {
    try {
      await navigator.clipboard.writeText(value);
      showNotice(successMessage);
    } catch {
      showNotice("复制失败，请手动输入房间口令", "error");
    }
  }

  async function leave() {
    if (leaving) return;
    setLeaving(true);
    await live.stopSharing().catch(() => undefined);
    await api.leaveRoom(session.sessionToken).catch(() => undefined);
    if (localHost) await window.electronAPI?.stopHostServer().catch(() => undefined);
    onLeave();
  }

  async function enterFullscreen() {
    try {
      await live.videoRef.current?.requestFullscreen();
    } catch {
      showNotice("无法进入全屏模式", "error");
    }
  }

  const inviteText = formatRoomInvitation({
    serverUrl: getApiBaseUrl(),
    code: session.room.code,
    title: session.room.title,
  });
  const connectionLabels = { connecting: "连接中", connected: "房间在线", reconnecting: "正在重连", failed: "连接失败", disconnected: "已断开" } as const;
  const transportLabels = { p2p: "P2P", turn: "TURN", sfu: "SFU" } as const;
  const isConnected = live.connectionState === "connected";
  const displayedSharer = live.sharers.find((sharer) => sharer.id === live.displayedSharerId);
  const pendingSharer = live.sharers.find((sharer) => sharer.id === live.selectedSharerId);
  const switchingViewer = Boolean(live.selectedSharerId && live.selectedSharerId !== live.displayedSharerId);
  const playerDetail = live.stats?.width
    ? `${live.stats.width}×${live.stats.height} · ${Math.round(live.stats.framesPerSecond ?? 0)}fps`
    : "实时画面";
  const publisherDetail = live.publisherStats?.width
    ? `${live.publisherStats.width}×${live.publisherStats.height} · ${Math.round(live.publisherStats.framesPerSecond ?? 0)}fps · ${live.publisherStats.bitrateKbps ?? 0} Kbps`
    : undefined;
  const connectionMetric = live.stats?.roundTripTimeMs ? `${live.stats.roundTripTimeMs} ms` : "--";
  const bitrateMetric = live.stats?.bitrateKbps ? `${live.stats.bitrateKbps} Kbps` : "--";

  return (
    <main className="room-shell">
      <header className="room-header">
        <div className="room-heading">
          <div className="brand-mark small"><Radio size={17} /></div>
          <div><strong>GameCast</strong><span>{session.room.title}</span></div>
        </div>
        <div className="room-code">
          <span>房间口令</span>
          <strong>{session.room.code}</strong>
        </div>
        <div className="room-actions">
          {live.transport && <span className={`transport-badge ${live.transport}`}>{transportLabels[live.transport]}</span>}
          <span className={`connection-dot ${live.connectionState} ${isConnected ? "online" : ""}`}><i />{connectionLabels[live.connectionState]}</span>
          <DiagnosticsButton />
          <ThemePicker theme={theme} onChange={onThemeChange} />
          <button className="quiet-button invite-button" type="button" onClick={() => void copyText(inviteText, "房间邀请已复制")}><Copy size={16} />复制邀请</button>
          <button className="quiet-button danger-quiet" type="button" onClick={() => setShowLeaveDialog(true)}><LogOut size={16} />退出房间</button>
        </div>
      </header>

      {live.mediaError && <div className="room-alert error"><WifiOff size={16} /><span>{live.mediaError}</span><button type="button" onClick={live.retryConnection}><RotateCw size={15} />重新连接</button></div>}
      {live.audioBlocked && <div className="room-alert audio"><Volume2 size={16} /><span>系统阻止了声音自动播放</span><button type="button" onClick={() => live.resumeAudio().catch(() => undefined)}>启用声音</button></div>}

      <div className="room-layout">
        <aside className="people-panel">
          <div className="people-heading">
            <div><span className="section-kicker">LIVE SOURCES</span><h2>正在共享</h2></div>
            <strong>{live.sharers.length}/{session.room.limits.maxSharers}</strong>
          </div>
          <div className="sharer-list">
            {live.sharers.map((sharer) => {
              const selected = live.selectedSharerId === sharer.id;
              const pending = selected && switchingViewer;
              return (
                <button className={`sharer-row ${selected ? "selected" : ""} ${pending ? "pending" : ""}`} key={sharer.id} type="button" onClick={() => live.selectSharer(sharer.id)}>
                  <span className="avatar">{sharer.name.slice(0, 1).toUpperCase()}</span>
                  <span className="sharer-meta">
                    <strong>{sharer.name}{sharer.isLocal && <em>你</em>}</strong>
                    <small>{pending ? <LoaderCircle className="spin" size={12} /> : <span className="live-indicator" />}{pending ? "正在连接" : `${sharer.viewerCount}/${session.room.limits.maxViewersPerShare} 人观看 · ${sharer.preset}`}</small>
                  </span>
                  <ChevronRight className="row-arrow" size={16} />
                </button>
              );
            })}
            {live.sharers.length === 0 && <div className="list-empty"><MonitorUp size={24} /><span>还没有共享画面</span><small>有人开始共享后会显示在这里</small></div>}
          </div>

          <div className="members-heading"><span>房间成员</span><strong>{live.participantCount}/{session.room.limits.maxParticipants}</strong></div>
          <div className="member-list">
            {live.participants.map((participant) => {
              const isSharer = live.sharers.some((sharer) => sharer.id === participant.id);
              return (
                <div className="member-row" key={participant.id}>
                  <span className="member-dot" />
                  <strong>{participant.displayName}</strong>
                  <small>{participant.role === "host" ? "房主" : isSharer ? "共享中" : "在线"}</small>
                </div>
              );
            })}
          </div>
          <div className="people-footer">
            <span><ShieldCheck size={14} />房间内加密传输</span>
          </div>
        </aside>

        <section className="player-column">
          <div className="stage-head">
            <div className="stage-title">
              <span className={`stage-live-dot ${displayedSharer ? "active" : ""}`} />
              <div><strong>{displayedSharer ? `${displayedSharer.name}的屏幕` : "共享画面"}</strong><span>{displayedSharer ? displayedSharer.preset : "选择左侧共享者开始观看"}</span></div>
            </div>
            <div className="stage-metrics">
              <span><small>画面</small><strong>{live.stats?.width ? `${live.stats.width}×${live.stats.height}` : "--"}</strong></span>
              <span><small>帧率</small><strong>{live.stats?.framesPerSecond ? `${Math.round(live.stats.framesPerSecond)} fps` : "--"}</strong></span>
              <span><small>码率</small><strong>{bitrateMetric}</strong></span>
              <span><small>延迟</small><strong>{connectionMetric}</strong></span>
            </div>
          </div>

          <div className="player-frame">
            <video ref={live.videoRef} autoPlay playsInline muted />
            <audio ref={live.audioRef} autoPlay />
            {!live.displayedSharerId && !switchingViewer && <div className="empty-player"><MonitorUp size={30} /><span>选择一名共享者观看</span><small>没有观众的共享不会上传视频</small></div>}
            {switchingViewer && <div className="view-connecting"><LoaderCircle className="spin" size={24} /><strong>正在连接 {pendingSharer?.name ?? "共享画面"}</strong><span>首帧到达后会自动完成切换</span></div>}
            {live.displayedSharerId && <div className="player-label"><span><span className="live-indicator" />{displayedSharer?.name}</span><span><Eye size={14} />{displayedSharer?.viewerCount ?? 0} 人观看 · {playerDetail}</span></div>}
          </div>

          <div className="player-toolbar">
            <div className="toolbar-tools">
              <button className="icon-button framed" title="全屏观看" aria-label="全屏观看" type="button" onClick={() => void enterFullscreen()} disabled={!live.displayedSharerId}><Maximize2 size={17} /></button>
              <div className={`toolbar-status ${live.isSharing && !live.hasSystemAudio ? "warning" : ""}`}><Volume2 size={17} /><span>{live.isSharing ? live.hasSystemAudio ? "系统声音正在共享" : "未捕获到系统声音" : "共享时包含系统声音"}</span>{live.isSharing && live.hasSystemAudio && <Check size={16} />}</div>
            </div>
            <div className="toolbar-telemetry">
              {live.isSharing && <div className="media-stats"><Gauge size={15} />{live.captureMode === "native" ? `${live.encoder ?? "硬件编码"}${publisherDetail ? ` · ${publisherDetail}` : ""}` : "浏览器兼容编码"}</div>}
              {live.stats && <div className="media-stats"><Network size={15} />{transportLabels[live.stats.transport]} · {bitrateMetric}{live.stats.roundTripTimeMs ? ` · ${connectionMetric}` : ""}</div>}
            </div>
            <div className="toolbar-spacer" />
            <label className={`select-control ${presetChanging ? "busy" : ""}`}><span>最高画质</span><select value={presetName} onChange={(event) => void changePreset(event.target.value)} disabled={presetChanging}>{VIDEO_PRESETS.map((item) => <option key={item.name} value={item.name}>{item.label} / 60fps</option>)}</select>{presetChanging ? <LoaderCircle className="spin" size={15} /> : <ChevronDown size={15} />}</label>
            {live.isSharing
              ? <button className="share-button stop" type="button" onClick={() => void stopShare()} disabled={shareStopping}>{shareStopping ? <LoaderCircle className="spin" size={17} /> : <CircleStop size={17} />}{shareStopping ? "正在停止" : "停止共享"}</button>
              : <button className="share-button" type="button" onClick={() => setShowSourcePicker(true)}><MonitorUp size={17} />开始共享</button>}
          </div>
        </section>
      </div>

      {showSourcePicker && (
        <div className="modal-backdrop">
          <section className="source-modal" role="dialog" aria-modal="true" aria-labelledby="source-title">
            <header><div><h2 id="source-title">选择共享内容</h2><span>画质是上限，观众增加时会自动调整</span></div><button className="icon-button" title="关闭" aria-label="关闭" type="button" onClick={() => setShowSourcePicker(false)} disabled={shareStarting}><X size={18} /></button></header>
            {sourcesLoading
              ? <div className="source-loading"><LoaderCircle className="spin" size={22} /><span>正在读取窗口列表</span></div>
              : <div className="source-grid">{sources.map((source) => <button className={`source-card ${selectedSourceId === source.id ? "selected" : ""}`} key={source.id} type="button" onClick={() => setSelectedSourceId(source.id)} disabled={shareStarting}>{source.thumbnail ? <img src={source.thumbnail} alt="" /> : <div className="source-placeholder"><MonitorUp size={26} /></div>}<span>{source.name}</span>{selectedSourceId === source.id && <Check className="source-check" size={16} />}</button>)}</div>}
            {shareError && <div className="form-error">{shareError}</div>}
            <footer><button className="quiet-button" type="button" onClick={() => setShowSourcePicker(false)} disabled={shareStarting}>取消</button><button className="primary-button compact" type="button" onClick={() => void confirmShare()} disabled={!selectedSourceId || sourcesLoading || shareStarting}>{shareStarting ? <LoaderCircle className="spin" size={17} /> : <MonitorUp size={17} />}{shareStarting ? "正在启动" : "开始共享"}</button></footer>
          </section>
        </div>
      )}

      {showLeaveDialog && (
        <div className="modal-backdrop">
          <section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="leave-title">
            <div className="confirm-icon"><TriangleAlert size={21} /></div>
            <div><h2 id="leave-title">退出“{session.room.title}”？</h2><p>{localHost ? "你是房主，退出后本机房间会立即结束，其他成员将断开连接。" : "退出后当前观看和共享连接会立即结束。"}</p></div>
            <footer><button className="quiet-button" type="button" onClick={() => setShowLeaveDialog(false)} disabled={leaving}>取消</button><button className="danger-button" type="button" onClick={() => void leave()} disabled={leaving}>{leaving ? <LoaderCircle className="spin" size={16} /> : <LogOut size={16} />}{leaving ? "正在退出" : "退出房间"}</button></footer>
          </section>
        </div>
      )}

      <div className={`room-toast ${notice ? "visible" : ""} ${notice?.tone ?? ""}`} role="status" aria-live="polite">
        {notice?.tone === "error" ? <TriangleAlert size={16} /> : <Check size={16} />}
        <span>{notice?.message}</span>
      </div>
    </main>
  );
}
