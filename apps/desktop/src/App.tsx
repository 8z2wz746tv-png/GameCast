import type { RoomLimits, RoomSession } from "@gamecast/contracts";
import {
  Check,
  ChevronDown,
  ChevronRight,
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
import { CircleStop as CircleStopNode, MonitorUp as MonitorUpNode } from "lucide";
import { MorphIcon } from "morphicons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  configureApiBaseUrl,
  getApiBaseUrl,
  getPublicControlServerUrl,
} from "./api";
import { diagnosticLog, errorDetails } from "./diagnostics";
import { VIDEO_PRESETS } from "./media";
import {
  type NetworkPreflightResult,
  runNetworkPreflight,
} from "./network-preflight";
import { getEffectiveQualityPolicy } from "./p2p/quality-policy";
import { formatRoomInvitation, parseRoomInvitation } from "./room-invitation";
import { isPrivateControlServerUrl } from "./server-address";
import { useRoomMedia } from "./use-room-media";
import type {
  CaptureSource,
  HostSettingsInput,
  HostSettingsStatus,
  NetworkInterfaceCandidate,
} from "./vite-env";

type EntryMode = "create" | "join";
type HostingMode = "local" | "internet";
type ActiveSession = { session: RoomSession; localHost: boolean; networkStarted: boolean; networkInvite?: NonNullable<ReturnType<typeof parseRoomInvitation>>["network"] };
type RoomNotice = { tone: "success" | "info" | "error"; message: string };
type ThemeId = "oasis" | "aurora" | "amber" | "rose" | "light";

const THEMES: Array<{ id: ThemeId; label: string; color: string }> = [
  { id: "oasis", label: "绿洲", color: "#61e3a2" },
  { id: "aurora", label: "极光", color: "#55c7ff" },
  { id: "amber", label: "琥珀", color: "#f4c55c" },
  { id: "rose", label: "玫瑰", color: "#ff7997" },
  { id: "light", label: "明亮", color: "#f5f7f6" },
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
      networkStarted={active.networkStarted}
      networkInvite={active.networkInvite}
      onLeave={() => setActive(null)}
      theme={theme}
      onThemeChange={setTheme}
    />
  ) : (
    <EntryView
      onSession={(session, localHost, networkStarted, networkInvite) => setActive({ session, localHost, networkStarted, networkInvite })}
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
  onSession: (session: RoomSession, localHost: boolean, networkStarted: boolean, networkInvite?: NonNullable<ReturnType<typeof parseRoomInvitation>>["network"]) => void;
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
}) {
  const [mode, setMode] = useState<EntryMode>("create");
  const publicServerUrl = getPublicControlServerUrl();
  const [hostingMode, setHostingMode] = useState<HostingMode>("internet");
  const [networkMode, setNetworkMode] = useState<"direct" | "easytier">("direct");
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
    easyTierPath: "",
    easyTierNetworkName: "",
    easyTierPeers: "",
  });
  const [easyTierSecret, setEasyTierSecret] = useState("");
  const [networkStatus, setNetworkStatus] = useState<import("./vite-env").NetworkAdapterStatus>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [invitationRecognized, setInvitationRecognized] = useState(false);
  const [invitationInput, setInvitationInput] = useState("");
  const [invitationNetwork, setInvitationNetwork] = useState<NonNullable<ReturnType<typeof parseRoomInvitation>>["network"]>();
  const [networkCheck, setNetworkCheck] = useState<NetworkPreflightResult>();
  const [networkChecking, setNetworkChecking] = useState(false);
  const [autoJoinRequested, setAutoJoinRequested] = useState(false);
  const entryFormRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!window.electronAPI) return;
    Promise.all([
      window.electronAPI.listNetworkInterfaces(),
      window.electronAPI.getHostSettings(),
      window.electronAPI.getNetworkStatus(),
    ]).then(([nextNetworks, settings, status]) => {
      setNetworks(nextNetworks);
      const preferred = nextNetworks.find((network) => network.recommended) ?? nextNetworks[0];
      setSelectedNetwork(preferred?.address ?? "");
      setHostSettings(settings);
      setNetworkStatus(status);
      setSettingsInput({
        turnUrls: settings.turnUrls,
        livekitServerUrl: settings.livekitServerUrl,
        easyTierPath: settings.easyTierPath,
        easyTierNetworkName: settings.easyTierNetworkName,
        easyTierPeers: settings.easyTierPeers.join(","),
      });
    });
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    let localHostStarted = false;
    let networkStarted = false;
    let startedNetworkStatus: import("./vite-env").NetworkAdapterStatus | undefined;
    try {
      diagnosticLog("entry", "submit.requested", {
        mode,
        hostingMode,
        serverUrl,
        hasInvitation: Boolean(code),
      });
      let effectiveServerUrl = serverUrl;
      if (mode === "join" && invitationNetwork && window.electronAPI) {
        const status = await window.electronAPI.startNetwork({
          networkName: invitationNetwork.name,
          networkSecret: invitationNetwork.secret,
          peers: invitationNetwork.peers,
        });
        networkStarted = status.state === "connected";
        startedNetworkStatus = status;
        setNetworkStatus(status);
      }
      if (mode === "create" && hostingMode === "local") {
        if (!window.electronAPI) throw new Error("本机房主模式只能在 Windows 客户端中使用");
        await window.electronAPI.saveHostSettings({
          ...settingsInput,
          easyTierNetworkSecret: networkMode === "easytier" ? easyTierSecret : undefined,
        });
        let hostAddress = selectedNetwork;
        if (networkMode === "easytier") {
          if (!easyTierSecret.trim() && !hostSettings?.hasEasyTierSecret) throw new Error("请输入 EasyTier 网络密钥");
          const status = await window.electronAPI.startNetwork({
            executablePath: settingsInput.easyTierPath,
            networkName: settingsInput.easyTierNetworkName ?? "",
            networkSecret: easyTierSecret,
            peers: parsePeers(settingsInput.easyTierPeers),
          });
          networkStarted = status.state === "connected";
          startedNetworkStatus = status;
          setNetworkStatus(status);
          hostAddress = status.virtualIp ?? "";
        }
        if (!hostAddress) throw new Error("没有找到可用的虚拟局域网地址");
        const hosted = await window.electronAPI.startHostServer(hostAddress);
        localHostStarted = true;
        effectiveServerUrl = hosted.serverUrl;
      }

      if (mode === "create" && hostingMode === "internet" && isPrivateControlServerUrl(effectiveServerUrl)) {
        throw new Error("互联网房间不能使用 192.168.x.x、10.x.x.x 或 100.64.x.x 地址，请填写公网控制节点；局域网地址请切换到本机房主。\n");
      }

      configureApiBaseUrl(effectiveServerUrl);
      const health = await api.health();
      const preflight = await runNetworkPreflight();
      setNetworkCheck(preflight);
      if (!preflight.controlReady) throw new Error(preflight.summary);
      if (mode === "create" && hostingMode === "internet" && preflight.verdict === "failed") {
        const fix = preflight.details.find((detail) => detail.startsWith("修复："));
        throw new Error(`${preflight.summary}${fix ? `。${fix}` : ""}`);
      }
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
      const sessionWithNetwork: RoomSession = {
        ...session,
        ...(networkStarted
          ? {
              network: {
                mode: "easytier" as const,
                virtualIp: startedNetworkStatus?.virtualIp,
                networkName: mode === "join" ? invitationNetwork?.name : settingsInput.easyTierNetworkName,
                peerAddresses: mode === "join" ? invitationNetwork?.peers : parsePeers(settingsInput.easyTierPeers),
              },
            }
          : {}),
      };
      const networkInvite = networkStarted
        ? mode === "join"
          ? invitationNetwork
          : {
              mode: "easytier" as const,
              name: settingsInput.easyTierNetworkName ?? "",
              secret: easyTierSecret,
              peers: parsePeers(settingsInput.easyTierPeers),
            }
        : undefined;
      onSession(sessionWithNetwork, localHostStarted, networkStarted, networkInvite);
    } catch (submitError) {
      if (localHostStarted) await window.electronAPI?.stopHostServer().catch(() => undefined);
      if (networkStarted) await window.electronAPI?.stopNetwork().catch(() => undefined);
      diagnosticLog("entry", "submit.failed", errorDetails(submitError), "error");
      setError(submitError instanceof Error ? submitError.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  const selectedNetworkInfo = networks.find((network) => network.address === selectedNetwork);

  const applyInvitation = useCallback((value: string, autoJoin = false): boolean => {
    const invitation = parseRoomInvitation(value);
    if (!invitation) return false;
    setServerUrl(invitation.serverUrl);
    setCode(invitation.code);
    setInvitationNetwork(invitation.network);
    setNetworkMode(invitation.network ? "easytier" : "direct");
    setMode("join");
    setInvitationRecognized(true);
    setInvitationInput(value);
    setError("");
    if (autoJoin && displayName.trim()) setAutoJoinRequested(true);
    return true;
  }, [displayName]);

  function handleServerPaste(event: React.ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData("text");
    if (applyInvitation(pasted, true)) event.preventDefault();
  }

  function handleServerChange(value: string) {
    if (applyInvitation(value)) return;
    setServerUrl(value);
    setInvitationRecognized(false);
  }

  async function checkNetwork() {
    if (networkChecking) return;
    setNetworkChecking(true);
    setError("");
    try {
      configureApiBaseUrl(serverUrl);
      setNetworkCheck(await runNetworkPreflight());
    } catch (checkError) {
      setError(checkError instanceof Error ? checkError.message : "网络检测失败");
    } finally {
      setNetworkChecking(false);
    }
  }

  useEffect(() => {
    const electronAPI = window.electronAPI;
    if (!electronAPI) return;
    void electronAPI.getPendingInvitation().then((value) => {
      if (value) applyInvitation(value, true);
    });
    return electronAPI.onInvitation((value) => applyInvitation(value, true));
  }, [applyInvitation]);

  useEffect(() => {
    if (!autoJoinRequested || mode !== "join" || !code || !serverUrl || busy) return;
    setAutoJoinRequested(false);
    const timer = window.setTimeout(() => entryFormRef.current?.requestSubmit(), 0);
    return () => window.clearTimeout(timer);
  }, [autoJoinRequested, busy, code, mode, serverUrl]);

  return (
    <main className="entry-shell">
      <section className="entry-panel wide">
        <div className="entry-tools"><ThemePicker theme={theme} onChange={onThemeChange} /></div>
        <div className="segmented-control" role="tablist" aria-label="房间操作">
          <button className={mode === "create" ? "active" : ""} onClick={() => setMode("create")} type="button">创建房间</button>
          <button className={mode === "join" ? "active" : ""} onClick={() => setMode("join")} type="button">加入房间</button>
        </div>

        <form ref={entryFormRef} className="entry-form" onSubmit={submit}>
          {mode === "join" && (
            <label>
              <span><Link2 size={14} />房间邀请</span>
              <input
                value={invitationInput}
                onChange={(event) => {
                  const value = event.target.value;
                  setInvitationInput(value);
                  if (!applyInvitation(value)) setInvitationRecognized(false);
                }}
                onPaste={(event) => {
                  const value = event.clipboardData.getData("text");
                  if (applyInvitation(value, true)) event.preventDefault();
                }}
                placeholder="粘贴朋友发来的整句邀请"
              />
              {invitationRecognized && <small className="field-success"><Check size={13} />邀请已识别，点击加入即可</small>}
            </label>
          )}

          <label>
            <span>你的昵称</span>
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={32} placeholder="在房间里显示的名称" required />
          </label>

          <details className="advanced-settings entry-advanced">
            <summary><Settings2 size={15} />高级设置</summary>
            <div className="advanced-settings-body">
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
            <div className="hosting-choice">
              <button type="button" className={networkMode === "direct" ? "active" : ""} onClick={() => setNetworkMode("direct")}><Link2 size={16} />现有虚拟网卡</button>
              <button type="button" className={networkMode === "easytier" ? "active" : ""} onClick={() => setNetworkMode("easytier")}><Network size={16} />内置 EasyTier</button>
            </div>
          )}

          {mode === "create" && hostingMode === "local" && networkMode === "direct" && (
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

          {mode === "create" && hostingMode === "local" && networkMode === "easytier" && (
            <div className="network-settings">
              <label><span><Network size={14} />EasyTier 网络名称</span><input value={settingsInput.easyTierNetworkName ?? ""} onChange={(event) => setSettingsInput((current) => ({ ...current, easyTierNetworkName: event.target.value }))} placeholder="例如：gamecast-friends" required /></label>
              <label><span>EasyTier 网络密钥</span><input type="password" value={easyTierSecret} onChange={(event) => setEasyTierSecret(event.target.value)} placeholder={hostSettings?.hasEasyTierSecret ? "已保存，留空使用本机密钥" : "仅保存在本机"} required={!hostSettings?.hasEasyTierSecret} /></label>
              <label><span>EasyTier 节点地址 <small>可选，逗号分隔</small></span><input value={settingsInput.easyTierPeers ?? ""} onChange={(event) => setSettingsInput((current) => ({ ...current, easyTierPeers: event.target.value }))} placeholder="tcp://节点地址:11010" /></label>
              <label><span>EasyTier 程序路径 <small>可选</small></span><input value={settingsInput.easyTierPath ?? ""} onChange={(event) => setSettingsInput((current) => ({ ...current, easyTierPath: event.target.value }))} placeholder="默认查找 resources/native/easytier-core.exe" /></label>
              <small className="field-warning">需要自行准备 EasyTier 核心程序和虚拟网卡驱动，GameCast 不会自动安装或修改防火墙。</small>
              {networkStatus && networkStatus.mode === "easytier" && <small className={networkStatus.state === "connected" ? "field-success" : "field-warning"}>EasyTier 状态：{networkStatus.state === "connected" ? `已连接${networkStatus.virtualIp ? ` · ${networkStatus.virtualIp}` : ""}` : networkStatus.state === "failed" ? networkStatus.lastError ?? "启动失败" : networkStatus.state === "starting" ? "启动中" : "未启动"}</small>}
            </div>
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
            <div className="network-settings nested-settings">
              <span className="settings-section-title">可选中转与 SFU</span>
              <label><span>STUN/TURN 地址 <small>逗号分隔</small></span><input value={settingsInput.turnUrls} onChange={(event) => setSettingsInput((current) => ({ ...current, turnUrls: event.target.value }))} placeholder="turn:host:3478?transport=udp" /></label>
              <label><span>TURN 共享密钥 {hostSettings?.hasTurnSecret && <small>已保存，留空保持不变</small>}</span><input type="password" value={settingsInput.turnSharedSecret ?? ""} onChange={(event) => setSettingsInput((current) => ({ ...current, turnSharedSecret: event.target.value }))} /></label>
              <label><span>LiveKit WebSocket 地址</span><input value={settingsInput.livekitServerUrl} onChange={(event) => setSettingsInput((current) => ({ ...current, livekitServerUrl: event.target.value }))} placeholder="wss://livekit.example.com" /></label>
              <div className="secret-grid">
                <label><span>LiveKit API Key</span><input type="password" value={settingsInput.livekitApiKey ?? ""} onChange={(event) => setSettingsInput((current) => ({ ...current, livekitApiKey: event.target.value }))} placeholder={hostSettings?.hasLivekitCredentials ? "已保存" : ""} /></label>
                <label><span>LiveKit API Secret</span><input type="password" value={settingsInput.livekitApiSecret ?? ""} onChange={(event) => setSettingsInput((current) => ({ ...current, livekitApiSecret: event.target.value }))} placeholder={hostSettings?.hasLivekitCredentials ? "已保存" : ""} /></label>
              </div>
            </div>
          )}
            </div>
          </details>

          <div className={`network-check-card ${networkCheck?.verdict ?? "idle"}`}>
            <div>
              <Network size={17} />
              <span><strong>{networkChecking ? "正在检测网络" : networkCheck?.summary ?? "连接前检查网络"}</strong><small>{networkCheck ? networkCheck.details[0] : "检测异地连接和备用线路是否可用"}</small></span>
            </div>
            <button className="quiet-button" type="button" onClick={() => void checkNetwork()} disabled={networkChecking}>
              {networkChecking ? <LoaderCircle className="spin" size={15} /> : <RotateCw size={15} />}
              {networkChecking ? "检测中" : "一键检测"}
            </button>
            {networkCheck && <details><summary>查看检测详情</summary><ul>{networkCheck.details.map((detail) => <li key={detail}>{detail}</li>)}</ul></details>}
          </div>

          {error && <div className="form-error">{error}</div>}
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={18} /> : mode === "create" ? <DoorOpen size={18} /> : <Link2 size={18} />}
            {busy ? "正在连接" : mode === "create" ? "创建并进入" : "加入房间"}
          </button>
        </form>
        <div className="entry-footer"><DiagnosticsButton label /><UpdateStatus /></div>
      </section>
    </main>
  );
}

function ThemePicker({ theme, onChange }: { theme: ThemeId; onChange: (theme: ThemeId) => void }) {
  return (
    <details className="theme-menu">
      <summary className="icon-button" title="切换外观" aria-label="切换外观"><Palette size={17} /></summary>
      <div className="theme-options" role="menu" aria-label="外观">
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

function parsePeers(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\r\n,;；]+/)
    .map((peer) => peer.trim())
    .filter(Boolean)
    .slice(0, 16);
}

function getQualityReason(
  requested: (typeof VIDEO_PRESETS)[number],
  actual: { width?: number; height?: number; framesPerSecond?: number; bitrateKbps?: number } | undefined,
  viewerCount: number,
  captureMode: "browser" | "native" | null,
): string {
  if (viewerCount >= 6) return "因观众数量已限制为 720p / 2.5Mbps";
  if (viewerCount >= 4) return "因观众数量已限制为 720p / 3.5Mbps";
  if (captureMode === "browser") return "硬件路径不可用，正在使用兼容捕获";
  if (!actual) return "等待首个观众后显示实时数据";
  if ((actual.width ?? 0) < requested.width || (actual.height ?? 0) < requested.height) {
    return "当前捕获链路未达到设定分辨率";
  }
  if ((actual.framesPerSecond ?? requested.frameRate) + 1 < requested.frameRate) {
    return "当前捕获或编码负载限制了帧率";
  }
  return "当前达到设定上限";
}

function LocalPreview({
  stream,
  hasSystemAudio,
  onHide,
}: {
  stream: MediaStream | null;
  hasSystemAudio: boolean;
  onHide: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const preview = stream ? new MediaStream(stream.getVideoTracks()) : null;
    video.srcObject = preview;
    if (preview) void video.play().catch(() => undefined);
    return () => {
      if (video.srcObject === preview) video.srcObject = null;
    };
  }, [stream]);
  return (
    <div className="local-preview">
      <video ref={ref} autoPlay playsInline muted />
      <span><i />本地预览 · {hasSystemAudio ? "含系统声音" : "无系统声音"}</span>
      <button className="icon-button" type="button" onClick={onHide} title="隐藏本地预览" aria-label="隐藏本地预览"><X size={14} /></button>
    </div>
  );
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
      setMessage("诊断日志已保存到桌面");
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
        title="导出诊断日志"
        aria-label="导出诊断日志"
        onClick={() => void exportDiagnostics()}
        disabled={busy}
        type="button"
      >
        {busy ? <LoaderCircle className="spin" size={16} /> : <FileDown size={16} />}
        {label && (busy ? "正在导出" : "导出诊断日志")}
      </button>
      {message && <small>{message}</small>}
    </div>
  );
}

function UpdateStatus() {
  const [version, setVersion] = useState("");
  const [update, setUpdate] = useState<import("./vite-env").AppUpdateInfo>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const electronAPI = window.electronAPI;

  useEffect(() => {
    if (!electronAPI) return;
    void electronAPI.getAppVersion().then(setVersion);
  }, []);

  if (!electronAPI) return null;
  const updateAvailable = Boolean(
    update?.latestVersion && isNewerVersion(update.latestVersion, update.currentVersion),
  );

  async function check() {
    if (checking) return;
    setChecking(true);
    setError("");
    try {
      const result = await electronAPI!.checkForUpdates();
      setVersion(result.currentVersion);
      setUpdate(result);
    } catch (checkError) {
      setError(checkError instanceof Error ? checkError.message : "版本检查失败");
    } finally {
      setChecking(false);
    }
  }

  return (
    <details className={`update-control ${updateAvailable ? "available" : ""}`}>
      <summary className="quiet-button"><RotateCw className={checking ? "spin" : ""} size={15} />{updateAvailable ? `发现 ${update?.latestVersion}` : `版本 ${version || "--"}`}</summary>
      <div className="update-popover">
        <strong>{updateAvailable ? "有新版本可用" : update ? "当前已是最新版本" : "检查软件更新"}</strong>
        {update?.name && <span>{update.name}</span>}
        {update?.notes && <p>{update.notes.slice(0, 420)}</p>}
        {error && <small className="field-warning">{error}</small>}
        <div>
          <button className="quiet-button" type="button" onClick={() => void check()} disabled={checking}>{checking ? <LoaderCircle className="spin" size={14} /> : <RotateCw size={14} />}{checking ? "检查中" : "检查更新"}</button>
          {updateAvailable && <button className="primary-button compact" type="button" onClick={() => void electronAPI.openReleasePage(update!.releaseUrl)}><FileDown size={14} />查看更新</button>}
        </div>
      </div>
    </details>
  );
}

function isNewerVersion(candidate: string, current: string): boolean {
  const parts = (value: string) => value.split(".").map((part) => Number(part.replace(/\D.*$/, "")) || 0);
  const left = parts(candidate);
  const right = parts(current);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) > (right[index] ?? 0);
  }
  return false;
}

function RoomView({ session, localHost, networkStarted, networkInvite, onLeave, theme, onThemeChange }: { session: RoomSession; localHost: boolean; networkStarted: boolean; networkInvite?: NonNullable<ReturnType<typeof parseRoomInvitation>>["network"]; onLeave: () => void; theme: ThemeId; onThemeChange: (theme: ThemeId) => void }) {
  const live = useRoomMedia(session);
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [showSourcePicker, setShowSourcePicker] = useState(false);
  const [showLeaveDialog, setShowLeaveDialog] = useState(false);
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [presetName, setPresetName] = useState("1080p");
  const [shareError, setShareError] = useState("");
  const [shareStarting, setShareStarting] = useState(false);
  const [sharePreflight, setSharePreflight] = useState<import("./vite-env").NativeMediaPreflightResult>();
  const [sharePreflightLoading, setSharePreflightLoading] = useState(false);
  const [measuredUploadKbps, setMeasuredUploadKbps] = useState<number>();
  const [previewVisible, setPreviewVisible] = useState(true);
  const [shareStopping, setShareStopping] = useState(false);
  const [presetChanging, setPresetChanging] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [notice, setNotice] = useState<RoomNotice | null>(null);
  const [clock, setClock] = useState(() => Date.now());
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

  useEffect(() => {
    if (!showSourcePicker || !selectedSourceId) {
      setSharePreflight(undefined);
      setMeasuredUploadKbps(undefined);
      return;
    }
    const electronAPI = window.electronAPI;
    const policy = getEffectiveQualityPolicy(preset, 1);
    if (!electronAPI) {
      setSharePreflight({
        sourceKind: selectedSourceId.startsWith("screen:") ? "screen" : "window",
        nativeAvailable: false,
        outputMapped: false,
        encoders: [],
        targetWidth: preset.width,
        targetHeight: preset.height,
        targetFrameRate: preset.frameRate,
        requiredUploadKbps: Math.round(policy.maxBitrate / 1000),
        issues: ["浏览器模式会在开始共享时确认实际画质和系统声音"],
      });
      return;
    }
    let active = true;
    setSharePreflightLoading(true);
    void Promise.all([
      electronAPI.preflightNativeMedia(
        selectedSourceId,
        preset,
        Math.round(policy.maxBitrate / 1000),
      ),
      api.measureUploadKbps().catch(() => undefined),
    ]).then(([result, uploadKbps]) => {
      if (!active) return;
      setSharePreflight(result);
      setMeasuredUploadKbps(uploadKbps);
    }).catch((error) => {
      if (active) setShareError(error instanceof Error ? error.message : "共享能力检测失败");
    }).finally(() => {
      if (active) setSharePreflightLoading(false);
    });
    return () => { active = false; };
  }, [preset, selectedSourceId, showSourcePicker]);

  useEffect(() => {
    if (!live.connectionStage.expiresAt) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [live.connectionStage.expiresAt]);

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
    if (networkStarted) await window.electronAPI?.stopNetwork().catch(() => undefined);
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
    network: networkInvite,
  });
  const connectionLabels = { connecting: "连接中", connected: "房间在线", reconnecting: "正在重连", failed: "连接失败", disconnected: "已断开" } as const;
  const transportLabels = { p2p: "P2P", turn: "TURN", sfu: "SFU" } as const;
  const isConnected = live.connectionState === "connected";
  const displayedSharer = live.sharers.find((sharer) => sharer.id === live.displayedSharerId);
  const pendingSharer = live.sharers.find((sharer) => sharer.id === live.selectedSharerId);
  const switchingViewer = Boolean(live.selectedSharerId && live.selectedSharerId !== live.displayedSharerId);
  const stageRemainingSeconds = live.connectionStage.expiresAt
    ? Math.max(0, Math.ceil((live.connectionStage.expiresAt - clock) / 1000))
    : undefined;
  const playerDetail = live.stats?.width
    ? `${live.stats.width}×${live.stats.height} · ${Math.round(live.stats.framesPerSecond ?? 0)}fps`
    : "实时画面";
  const publisherDetail = live.publisherStats?.width
    ? `${live.publisherStats.width}×${live.publisherStats.height} · ${Math.round(live.publisherStats.framesPerSecond ?? 0)}fps · ${live.publisherStats.bitrateKbps ?? 0} Kbps`
    : undefined;
  const connectionMetric = live.stats?.roundTripTimeMs ? `${live.stats.roundTripTimeMs} ms` : "--";
  const bitrateMetric = live.stats?.bitrateKbps ? `${live.stats.bitrateKbps} Kbps` : "--";
  const localShare = live.sharers.find((sharer) => sharer.isLocal);
  const qualityReason = getQualityReason(
    preset,
    live.publisherStats,
    localShare?.viewerCount ?? 0,
    live.captureMode,
  );

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
          {networkStarted && <span className="transport-badge p2p" title="已启用内置 EasyTier 虚拟网络"><Network size={14} />组网已连接</span>}
          {live.transport && <span className={`transport-badge ${live.transport}`}>{transportLabels[live.transport]}</span>}
          <span className={`connection-dot ${live.connectionState} ${isConnected ? "online" : ""}`}><i />{connectionLabels[live.connectionState]}</span>
          <DiagnosticsButton />
          <ThemePicker theme={theme} onChange={onThemeChange} />
          <button className="quiet-button invite-button" type="button" onClick={() => void copyText(inviteText, "房间邀请已复制")}><Copy size={16} />复制邀请</button>
          <button className="quiet-button danger-quiet" type="button" onClick={() => setShowLeaveDialog(true)}><LogOut size={16} />退出房间</button>
        </div>
      </header>

      {live.mediaError && <div className="room-alert error"><WifiOff size={16} /><span>{live.mediaError}</span><button type="button" onClick={live.connectionStage.phase === "failed" ? live.retryMediaConnection : live.retryConnection}><RotateCw size={15} />{live.connectionStage.phase === "failed" ? "重试观看" : "重新连接"}</button></div>}
      {live.audioBlocked && <div className="room-alert audio"><Volume2 size={16} /><span>系统阻止了声音自动播放</span><button type="button" onClick={() => live.resumeAudio().catch(() => undefined)}>启用声音</button></div>}
      {live.isSharing && <div className="room-alert privacy"><MonitorUp size={16} /><span><strong>正在共享屏幕内容</strong>{live.hasSystemAudio ? "，系统声音也会被朋友听到" : "，当前没有捕获系统声音"}</span><i className="privacy-pulse" /></div>}

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
              <div><strong>{displayedSharer ? `${displayedSharer.name}的屏幕` : "共享画面"}</strong><span>{displayedSharer ? `设定上限 ${displayedSharer.preset} / 60fps` : "选择左侧共享者开始观看"}</span></div>
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
            {switchingViewer && <div className={`view-connecting ${live.connectionStage.phase}`}>
              {live.connectionStage.phase === "failed" ? <WifiOff size={24} /> : <LoaderCircle className="spin" size={24} />}
              <strong>{live.connectionStage.message || `正在连接 ${pendingSharer?.name ?? "共享画面"}`}</strong>
              <span>{stageRemainingSeconds !== undefined && stageRemainingSeconds > 0 ? `剩余约 ${stageRemainingSeconds} 秒` : live.connectionStage.phase === "failed" ? "可以立即重试，或选择其他共享者" : "首帧到达后会自动完成切换"}</span>
              {live.connectionStage.phase === "failed" && <button className="quiet-button" type="button" onClick={live.retryMediaConnection}><RotateCw size={15} />重试观看</button>}
            </div>}
            {live.displayedSharerId && <div className="player-label"><span><span className="live-indicator" />{displayedSharer?.name}</span><span><Eye size={14} />{displayedSharer?.viewerCount ?? 0} 人观看 · {playerDetail}</span></div>}
            {live.isSharing && previewVisible && <LocalPreview stream={live.localPreviewStream} onHide={() => setPreviewVisible(false)} hasSystemAudio={live.hasSystemAudio} />}
          </div>

          <div className="player-toolbar">
            <div className="toolbar-tools">
              <button className="icon-button framed" title="全屏观看" aria-label="全屏观看" type="button" onClick={() => void enterFullscreen()} disabled={!live.displayedSharerId}><Maximize2 size={17} /></button>
              <div className={`toolbar-status ${live.isSharing && !live.hasSystemAudio ? "warning" : ""}`}><Volume2 size={17} /><span>{live.isSharing ? live.hasSystemAudio ? "系统声音正在共享" : "未捕获到系统声音" : "共享时包含系统声音"}</span>{live.isSharing && live.hasSystemAudio && <Check size={16} />}</div>
            </div>
            <div className="toolbar-telemetry">
              {live.isSharing && <div className="media-stats quality-status"><Gauge size={15} /><span><strong>设定 {preset.label} / 60fps</strong><small>{live.captureMode === "native" ? `${live.encoder ?? "硬件编码"}${publisherDetail ? ` · 实际 ${publisherDetail}` : ""}` : "浏览器兼容编码"}{qualityReason ? ` · ${qualityReason}` : ""}</small></span></div>}
              {live.stats && <div className="media-stats"><Network size={15} />{transportLabels[live.stats.transport]} · {bitrateMetric}{live.stats.roundTripTimeMs ? ` · ${connectionMetric}` : ""}</div>}
            </div>
            <div className="toolbar-spacer" />
            <label className={`select-control ${presetChanging ? "busy" : ""}`}><span>最高画质</span><select value={presetName} onChange={(event) => void changePreset(event.target.value)} disabled={presetChanging}>{VIDEO_PRESETS.map((item) => <option key={item.name} value={item.name}>{item.label} / 60fps</option>)}</select>{presetChanging ? <LoaderCircle className="spin" size={15} /> : <ChevronDown size={15} />}</label>
            <button
              className={`share-button ${live.isSharing ? "stop" : ""}`}
              type="button"
              onClick={() => {
                if (live.isSharing) void stopShare();
                else {
                  setPreviewVisible(true);
                  setShowSourcePicker(true);
                }
              }}
              disabled={shareStopping}
            >
              {shareStopping
                ? <LoaderCircle className="spin" size={17} />
                : <MorphIcon icon={live.isSharing ? CircleStopNode : MonitorUpNode} size={17} strokeWidth={2} spring="snappy" reducedMotion="user" />}
              {shareStopping ? "正在停止" : live.isSharing ? "停止共享" : "开始共享"}
            </button>
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
            <div className={`share-preflight ${sharePreflight?.nativeAvailable ? "ready" : "limited"}`}>
              <div className="preflight-heading">{sharePreflightLoading ? <LoaderCircle className="spin" size={17} /> : sharePreflight?.nativeAvailable ? <Check size={17} /> : <TriangleAlert size={17} />}<strong>{sharePreflightLoading ? "正在检查共享能力" : sharePreflight?.nativeAvailable ? "共享能力正常" : "将使用兼容方案"}</strong></div>
              {sharePreflight && <div className="preflight-grid">
                <span><small>显示器</small><strong>{sharePreflight.outputMapped ? "映射正确" : sharePreflight.sourceKind === "window" ? "窗口捕获" : "待兼容处理"}</strong></span>
                <span><small>编码</small><strong>{sharePreflight.recommendedEncoder ?? "兼容编码"}</strong></span>
                <span><small>目标</small><strong>{sharePreflight.targetWidth}×{sharePreflight.targetHeight} · {sharePreflight.targetFrameRate}fps</strong></span>
                <span><small>每名观众上行</small><strong>约 {sharePreflight.requiredUploadKbps} Kbps</strong></span>
                <span><small>实测上行</small><strong>{measuredUploadKbps ? `${(measuredUploadKbps / 1000).toFixed(1)} Mbps` : "未完成"}</strong></span>
                <span><small>系统声音</small><strong>启动时实际检测</strong></span>
              </div>}
              {sharePreflight && measuredUploadKbps && measuredUploadKbps < sharePreflight.requiredUploadKbps && <small className="field-warning">实测上传低于单名观众的目标码率，实际画质可能自动下降</small>}
              {sharePreflight?.issues.map((issue) => <small className="field-warning" key={issue}>{issue}</small>)}
            </div>
            {shareError && <div className="form-error">{shareError}</div>}
            <footer><button className="quiet-button" type="button" onClick={() => setShowSourcePicker(false)} disabled={shareStarting}>取消</button><button className="primary-button compact" type="button" onClick={() => void confirmShare()} disabled={!selectedSourceId || sourcesLoading || sharePreflightLoading || shareStarting}>{shareStarting ? <LoaderCircle className="spin" size={17} /> : <MonitorUp size={17} />}{shareStarting ? "正在检查画面与声音" : "开始共享"}</button></footer>
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
