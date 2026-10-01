import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, networkInterfaces, release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  IceCandidateData,
  SessionDescriptionData,
  VideoPreset,
} from "@gamecast/contracts";
import type {
  ControlServerRuntimeConfig,
  LiveKitRuntimeConfig,
  TurnRuntimeConfig,
} from "@gamecast/server/config";
import {
  type ControlServerHandle,
  startControlServer,
} from "@gamecast/server/embedded";
import {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  safeStorage,
  session,
  shell,
} from "electron";
import {
  type DiagnosticLogEntry,
  DiagnosticsService,
} from "./diagnostics.js";
import { resolveDevServerUrl } from "./dev-server-url.js";
import {
  type HostSettingsInput,
  parseBitrate,
  parseConnectionId,
  parseEasyTierStart,
  parseHostSettings,
  parseIceCandidate,
  parseIpv4Address,
  parseNativeStart,
  parsePreset,
  parseSessionDescription,
  parseSourceId,
} from "./ipc-validation.js";
import {
  type NativeMediaEvent,
  NativeMediaService,
  type NativeMediaStartRequest,
} from "./native-media.js";
import {
  EmbeddedEasyTierAdapter,
  type NetworkAdapterStatus,
} from "./network-adapter.js";

app.commandLine.appendSwitch("disable-features", "WebRtcHideLocalIpsWithMdns");
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-accelerated-video-encode");
app.commandLine.appendSwitch("enable-zero-copy");
app.commandLine.appendSwitch(
  "enable-features",
  "WebRtcMediaFoundationH264Encoding,WebRtcUseGpuMemoryBufferVideoFrames",
);

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const execFileAsync = promisify(execFile);
let selectedSourceId: string | undefined;
let selectedNativeOutputIndex: number | undefined;
const nativeOutputIndexes = new Map<string, number>();
let hostedServer: ControlServerHandle | undefined;
let diagnostics: DiagnosticsService | undefined;
const nativeMedia = new NativeMediaService((event) => broadcastNativeMediaEvent(event));
let networkAdapter: EmbeddedEasyTierAdapter | undefined;
let pendingProtocolUrl: string | undefined;

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) app.quit();

type NetworkCandidate = {
  id: string;
  name: string;
  address: string;
  kind: "easytier" | "tailscale" | "zerotier" | "wireguard" | "other";
  recommended: boolean;
};

type HostSettingsSecrets = {
  turnSharedSecret?: string;
  livekitApiKey?: string;
  livekitApiSecret?: string;
  easyTierNetworkSecret?: string;
};

type PersistedHostSettings = {
  turnUrls: string;
  livekitServerUrl: string;
  encryptedSecrets?: string;
  easyTierPath?: string;
  easyTierNetworkName?: string;
  easyTierPeers?: string[];
};

function registerCaptureHandlers(): void {
  ipcMain.handle("capture:list-sources", async () => {
    const [screens, windows] = await Promise.all([
      desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 320, height: 180 },
      }),
      desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: true,
      }),
    ]);
    nativeOutputIndexes.clear();
    const calibration = await nativeMedia.calibrateOutputIndexes(
      screens.map((source) => {
        const size = source.thumbnail.getSize();
        return {
          sourceId: source.id,
          width: size.width,
          height: size.height,
          pixels: source.thumbnail.toBitmap(),
        };
      }),
    );
    if (calibration.reliable) {
      for (const match of calibration.matches) {
        nativeOutputIndexes.set(match.sourceId, match.outputIndex);
      }
    }
    diagnostics?.log({
      scope: "capture",
      event: "sources.listed",
      data: {
        screens: screens.length,
        windows: windows.length,
        nativeOutputCalibration: {
          reliable: calibration.reliable,
          averageDistance: calibration.averageDistance,
          assignmentMargin: calibration.assignmentMargin,
          matches: calibration.matches,
        },
      },
    });
    return [...screens, ...windows].map((source) => ({
      id: source.id,
      name: source.name,
      thumbnail: source.thumbnail.toDataURL(),
      appIcon: source.appIcon?.toDataURL(),
    }));
  });

  ipcMain.handle("capture:select-source", (_event, sourceId: string) => {
    sourceId = parseSourceId(sourceId);
    selectedSourceId = sourceId;
    selectedNativeOutputIndex = nativeOutputIndexes.get(sourceId);
    diagnostics?.log({
      scope: "capture",
      event: "source.selected",
      data: {
        kind: sourceId.startsWith("screen:") ? "screen" : "window",
        outputIndex: selectedNativeOutputIndex,
      },
    });
  });

  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const sources = await desktopCapturer.getSources({
      types: ["window", "screen"],
      thumbnailSize: { width: 16, height: 16 },
    });
    const source = sources.find((candidate) => candidate.id === selectedSourceId) ?? sources[0];
    if (!source) {
      callback({ video: undefined });
      return;
    }
    callback({
      video: source,
      ...(request.audioRequested ? { audio: "loopback" as const } : {}),
    });
  });
}

function registerNativeMediaHandlers(): void {
  ipcMain.handle(
    "native-media:preflight",
    async (_event, sourceId: string, preset: VideoPreset, requiredUploadKbps: number) => {
      sourceId = parseSourceId(sourceId);
      preset = parsePreset(preset);
      requiredUploadKbps = Math.max(500, Math.min(50_000, Number(requiredUploadKbps) || 0));
      const outputIndex = nativeOutputIndexes.get(sourceId);
      const result = await nativeMedia.preflight(
        sourceId,
        outputIndex,
        preset,
        requiredUploadKbps,
      );
      diagnostics?.log({ scope: "capture", event: "preflight.completed", data: result });
      return result;
    },
  );
  ipcMain.handle("native-media:start", async (_event, request: NativeMediaStartRequest) => {
    request = parseNativeStart(request);
    const outputIndex = request.sourceId === selectedSourceId
      ? selectedNativeOutputIndex
      : undefined;
    try {
      if (
        request.sourceId.startsWith("screen:") &&
        outputIndex === undefined
      ) {
        throw new Error("无法可靠识别所选屏幕的硬件输出，已阻止原生捕获以避免共享错误画面");
      }
      const result = await nativeMedia.start({ ...request, outputIndex });
      writeNativeMediaLog(
        `started source=${request.sourceId} output=${String(outputIndex)} encoder=${result.encoder} ` +
        `capture=${result.captureBackend} pipeline=${result.pipeline} ` +
        `${result.width}x${result.height}@${result.frameRate} audio=${result.hasSystemAudio ? "connected" : request.audioOffer ? `failed (${result.audioError ?? "unknown error"})` : "not captured"}`,
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      writeNativeMediaLog(
        `start failed source=${request.sourceId} output=${String(outputIndex)} error=${message}`,
      );
      throw error;
    }
  });
  ipcMain.handle(
    "native-media:update-preset",
    async (_event, preset: VideoPreset, maxBitrate: number) => {
      preset = parsePreset(preset);
      maxBitrate = parseBitrate(maxBitrate);
      writeNativeMediaLog(
        `preset update requested ${preset.width}x${preset.height}@${preset.frameRate} bitrate=${Math.round(maxBitrate / 1000)}`,
      );
      try {
        const result = await nativeMedia.updatePreset(preset, maxBitrate);
        writeNativeMediaLog(
          `preset update completed ${result.width}x${result.height}@${result.frameRate} ` +
          `bitrate=${result.bitrateKbps} capture=${result.captureBackend} pipeline=${result.pipeline}`,
        );
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        writeNativeMediaLog(`preset update failed error=${message}`);
        throw error;
      }
    },
  );
  ipcMain.handle("native-media:create-offer", (_event, connectionId: string) =>
    nativeMedia.createOffer(parseConnectionId(connectionId)),
  );
  ipcMain.handle(
    "native-media:set-answer",
    (_event, connectionId: string, answer: SessionDescriptionData) =>
      nativeMedia.setAnswer(
        parseConnectionId(connectionId),
        parseSessionDescription(answer),
      ),
  );
  ipcMain.handle(
    "native-media:add-ice",
    (_event, connectionId: string, candidate: IceCandidateData | null) =>
      nativeMedia.addIceCandidate(
        parseConnectionId(connectionId),
        parseIceCandidate(candidate),
      ),
  );
  ipcMain.handle("native-media:close-peer", (_event, connectionId: string) =>
    nativeMedia.closePeer(parseConnectionId(connectionId)),
  );
  ipcMain.handle("native-media:stop", async () => {
    writeNativeMediaLog("stop requested by renderer");
    await nativeMedia.stop();
    writeNativeMediaLog("stopped");
  });
}

function registerAppHandlers(): void {
  ipcMain.handle("app:get-version", () => app.getVersion());
  ipcMain.handle("app:get-pending-invitation", () => {
    const value = pendingProtocolUrl;
    pendingProtocolUrl = undefined;
    return value;
  });
  ipcMain.handle("app:check-update", async () => {
    const response = await fetch(
      "https://api.github.com/repos/8z2wz746tv-png/GameCast/releases/latest",
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": `GameCast/${app.getVersion()}`,
        },
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok) throw new Error(`版本服务返回 ${response.status}`);
    const release = await response.json() as {
      tag_name?: string;
      name?: string;
      body?: string;
      html_url?: string;
      published_at?: string;
    };
    const releaseUrl = release.html_url;
    if (!releaseUrl || !isTrustedReleaseUrl(releaseUrl)) throw new Error("版本服务返回了无效地址");
    return {
      currentVersion: app.getVersion(),
      latestVersion: (release.tag_name ?? "").replace(/^v/i, ""),
      name: release.name ?? release.tag_name ?? "最新版本",
      notes: (release.body ?? "").slice(0, 8_000),
      releaseUrl,
      publishedAt: release.published_at,
    };
  });
  ipcMain.handle("app:open-release", async (_event, releaseUrl: string) => {
    if (!isTrustedReleaseUrl(releaseUrl)) throw new Error("只允许打开 GameCast 官方发布页");
    await shell.openExternal(releaseUrl);
  });
}

function isTrustedReleaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.pathname.startsWith("/8z2wz746tv-png/GameCast/releases");
  } catch {
    return false;
  }
}

function extractProtocolUrl(argv: string[]): string | undefined {
  return argv.find((value) => /^gamecast:\/\//i.test(value));
}

function dispatchProtocolUrl(value: string): void {
  pendingProtocolUrl = value;
  const window = BrowserWindow.getAllWindows()[0];
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  window.webContents.send("app:invitation", value);
}

function broadcastNativeMediaEvent(event: NativeMediaEvent): void {
  if (event.type === "error") writeNativeMediaLog(`runtime error=${event.message}`);
  if (event.type === "publisher-stats") {
    writeNativeMediaLog(
      `publisher fps=${event.framesPerSecond} bitrateKbps=${event.bitrateKbps} ` +
      `rtpPackets=${event.rtpPackets ?? 0} sentPackets=${event.sentRtpPackets ?? 0} ` +
      `queuePackets=${event.sendQueuePackets ?? 0} queueBytes=${event.sendQueueBytes ?? 0} ` +
      `droppedPackets=${event.droppedRtpPackets ?? 0}`,
    );
  }
  if (event.type === "encoder-recovery") {
    writeNativeMediaLog(
      `encoder recovery state=${event.state} attempt=${event.attempt} ` +
      `reason=${event.reason}${event.message ? ` message=${event.message}` : ""}`,
    );
  }
  if (event.type === "connection-state") {
    writeNativeMediaLog(`peer=${event.connectionId} state=${event.state}`);
  }
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("native-media:event", event);
  }
}

function writeNativeMediaLog(message: string): void {
  try {
    diagnostics?.log({ scope: "native-media", event: "message", data: { message } });
  } catch {
    // Diagnostics must never interrupt media startup.
  }
}

function registerHostHandlers(): void {
  ipcMain.handle("host:list-networks", () => listNetworkCandidates());
  ipcMain.handle("network:list", () => listNetworkCandidates());
  ipcMain.handle("network:get-status", () => networkAdapter?.status ?? createDirectNetworkStatus());
  ipcMain.handle("network:start", async (_event, input: unknown) => {
    if (!networkAdapter) throw new Error("网络适配器尚未初始化");
    const parsed = parseEasyTierStart(input);
    const savedSecret = decryptSecrets(readHostSettings()).easyTierNetworkSecret;
    const networkRequest = {
      ...parsed,
      networkSecret: parsed.networkSecret || savedSecret || "",
    };
    diagnostics?.log({
      scope: "network",
      event: "easytier.start.requested",
      data: { networkName: parsed.networkName, peerCount: parsed.peers?.length ?? 0 },
    });
    try {
      const result = await networkAdapter.start(networkRequest);
      diagnostics?.log({
        scope: "network",
        event: "easytier.started",
        data: { state: result.state, virtualIp: result.virtualIp, interfaceName: result.interfaceName },
      });
      return result;
    } catch (error) {
      diagnostics?.log({
        level: "error",
        scope: "network",
        event: "easytier.start.failed",
        data: { error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  });
  ipcMain.handle("network:stop", async () => {
    await networkAdapter?.stop();
    diagnostics?.log({ scope: "network", event: "easytier.stopped" });
  });
  ipcMain.handle("network:diagnostics", async () =>
    networkAdapter?.diagnostics() ?? { status: createDirectNetworkStatus(), interfaces: [] },
  );
  ipcMain.handle("network:local-preflight", async () => {
    const networkStatus = networkAdapter?.status ?? createDirectNetworkStatus();
    const candidates = listNetworkCandidates();
    return {
      networkStatus,
      firewallEnabled: await readWindowsFirewallState(),
      interfaceCount: candidates.length,
      recommendedInterfaceCount: candidates.filter((candidate) => candidate.recommended).length,
    };
  });
  ipcMain.handle("host:get-settings", () => getPublicHostSettings());
  ipcMain.handle("host:save-settings", (_event, input: HostSettingsInput) => {
    input = parseHostSettings(input);
    saveHostSettings(input);
    const settings = getPublicHostSettings();
    diagnostics?.log({
      scope: "host",
      event: "settings.saved",
      data: {
        turnConfigured: Boolean(settings.turnUrls && settings.hasTurnSecret),
        sfuConfigured: Boolean(settings.livekitServerUrl && settings.hasLivekitCredentials),
      },
    });
    return settings;
  });
  ipcMain.handle("host:start", async (_event, address: string) => {
    address = parseIpv4Address(address);
    diagnostics?.log({ scope: "host", event: "start.requested", data: { address } });
    try {
      const result = await startHostedServer(address);
      diagnostics?.log({
        scope: "host",
        event: "started",
        data: { address: result.address, port: result.port, networkKind: result.networkKind },
      });
      return result;
    } catch (error) {
      diagnostics?.log({
        level: "error",
        scope: "host",
        event: "start.failed",
        data: { error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  });
  ipcMain.handle("host:stop", async () => {
    diagnostics?.log({ scope: "host", event: "stop.requested" });
    await stopHostedServer();
    diagnostics?.log({ scope: "host", event: "stopped" });
  });
}

async function readWindowsFirewallState(): Promise<boolean | undefined> {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const powershell = join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  try {
    const { stdout } = await execFileAsync(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[bool](Get-NetFirewallProfile | Where-Object Enabled)",
      ],
      { windowsHide: true, timeout: 3_000 },
    );
    const value = stdout.trim().toLowerCase();
    if (value === "true") return true;
    if (value === "false") return false;
  } catch (error) {
    diagnostics?.log({
      level: "warn",
      scope: "network",
      event: "firewall-state.failed",
      data: { error: error instanceof Error ? error.message : String(error) },
    });
  }
  return undefined;
}

function registerDiagnosticHandlers(): void {
  ipcMain.on("diagnostics:log", (_event, entry: DiagnosticLogEntry) => {
    if (!entry || typeof entry.scope !== "string" || typeof entry.event !== "string") return;
    diagnostics?.log(entry);
  });
  ipcMain.handle("diagnostics:export", async () => {
    if (!diagnostics) throw new Error("诊断日志服务尚未启动");
    diagnostics.log({ scope: "diagnostics", event: "export.requested" });
    const path = await diagnostics.exportBundle();
    shell.showItemInFolder(path);
    return { path };
  });
}

function listNetworkCandidates(): NetworkCandidate[] {
  const result: NetworkCandidate[] = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      if (entry.address.startsWith("169.254.")) continue;
      const kind = detectNetworkKind(name);
      result.push({
        id: `${name}:${entry.address}`,
        name,
        address: entry.address,
        kind,
        recommended: kind !== "other",
      });
    }
  }
  return result.sort((left, right) => {
    if (left.recommended !== right.recommended) return left.recommended ? -1 : 1;
    const leftVirtualMachine = /virtualbox|vmware|hyper-v|vethernet/i.test(left.name);
    const rightVirtualMachine = /virtualbox|vmware|hyper-v|vethernet/i.test(right.name);
    if (leftVirtualMachine !== rightVirtualMachine) return leftVirtualMachine ? 1 : -1;
    return left.name.localeCompare(right.name);
  });
}

function detectNetworkKind(name: string): NetworkCandidate["kind"] {
  if (/easytier/i.test(name)) return "easytier";
  if (/tailscale/i.test(name)) return "tailscale";
  if (/zerotier/i.test(name)) return "zerotier";
  if (/wireguard|wintun/i.test(name)) return "wireguard";
  return "other";
}

function createDirectNetworkStatus(): NetworkAdapterStatus {
  return {
    mode: "direct",
    state: "disabled",
    peerCount: 0,
    recentLogs: [],
  };
}

async function startHostedServer(address: string) {
  const candidate = listNetworkCandidates().find((network) => network.address === address);
  if (!candidate) throw new Error("选择的虚拟网卡地址已经不可用");
  await stopHostedServer();
  const settings = readHostSettings();
  const secrets = decryptSecrets(settings);
  const turn = createTurnConfig(settings, secrets);
  const livekit = createLiveKitConfig(settings, secrets);

  let lastError: unknown;
  for (let port = 8787; port <= 8797; port += 1) {
    const config: ControlServerRuntimeConfig = {
      host: address,
      port,
      clientOrigins: ["http://localhost:5173", "null"],
      logger: false,
      deploymentMode: "embedded",
      stunUrls: [],
      turn,
      livekit,
      reconnectGraceSeconds: 10,
      connectionTimeoutSeconds: 20,
      sfuViewerThreshold: 2,
    };
    try {
      hostedServer = await startControlServer(config);
      return {
        serverUrl: hostedServer.url,
        address,
        port: hostedServer.port,
        networkName: candidate.name,
        networkKind: candidate.kind,
        turnConfigured: Boolean(turn),
        sfuConfigured: Boolean(livekit),
      };
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("无法启动本机房主服务");
}

async function stopHostedServer(): Promise<void> {
  const current = hostedServer;
  hostedServer = undefined;
  if (current) await current.close();
}

function createTurnConfig(
  settings: PersistedHostSettings,
  secrets: HostSettingsSecrets,
): TurnRuntimeConfig | undefined {
  const urls = settings.turnUrls.split(",").map((value) => value.trim()).filter(Boolean);
  if (urls.length === 0) return undefined;
  return { urls, sharedSecret: secrets.turnSharedSecret };
}

function createLiveKitConfig(
  settings: PersistedHostSettings,
  secrets: HostSettingsSecrets,
): LiveKitRuntimeConfig | undefined {
  if (
    !settings.livekitServerUrl ||
    !secrets.livekitApiKey ||
    !secrets.livekitApiSecret
  ) {
    return undefined;
  }
  return {
    serverUrl: settings.livekitServerUrl,
    apiKey: secrets.livekitApiKey,
    apiSecret: secrets.livekitApiSecret,
  };
}

function getPublicHostSettings() {
  const settings = readHostSettings();
  const secrets = decryptSecrets(settings);
  return {
    turnUrls: settings.turnUrls,
    livekitServerUrl: settings.livekitServerUrl,
    hasTurnSecret: Boolean(secrets.turnSharedSecret),
    hasLivekitCredentials: Boolean(secrets.livekitApiKey && secrets.livekitApiSecret),
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    easyTierPath: settings.easyTierPath ?? "",
    easyTierNetworkName: settings.easyTierNetworkName ?? "",
    easyTierPeers: settings.easyTierPeers ?? [],
    hasEasyTierSecret: Boolean(secrets.easyTierNetworkSecret),
  };
}

function saveHostSettings(input: HostSettingsInput): void {
  const existing = readHostSettings();
  const secrets = decryptSecrets(existing);
  if (input.clearTurnSecret) delete secrets.turnSharedSecret;
  if (input.clearLivekitCredentials) {
    delete secrets.livekitApiKey;
    delete secrets.livekitApiSecret;
  }
  if (input.turnSharedSecret?.trim()) secrets.turnSharedSecret = input.turnSharedSecret.trim();
  if (input.livekitApiKey?.trim()) secrets.livekitApiKey = input.livekitApiKey.trim();
  if (input.livekitApiSecret?.trim()) secrets.livekitApiSecret = input.livekitApiSecret.trim();
  if (input.clearEasyTierSecret) delete secrets.easyTierNetworkSecret;
  if (input.easyTierNetworkSecret?.trim()) secrets.easyTierNetworkSecret = input.easyTierNetworkSecret.trim();

  const persisted: PersistedHostSettings = {
    turnUrls: input.turnUrls.trim(),
    livekitServerUrl: input.livekitServerUrl.trim(),
    easyTierPath: input.easyTierPath?.trim() ?? existing.easyTierPath,
    easyTierNetworkName: input.easyTierNetworkName?.trim() ?? existing.easyTierNetworkName,
    easyTierPeers: parsePeerList(input.easyTierPeers ?? existing.easyTierPeers?.join(",")),
  };
  if (safeStorage.isEncryptionAvailable() && Object.keys(secrets).length > 0) {
    persisted.encryptedSecrets = safeStorage
      .encryptString(JSON.stringify(secrets))
      .toString("base64");
  }
  const path = hostSettingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(persisted, null, 2), "utf8");
}

function readHostSettings(): PersistedHostSettings {
  try {
    return JSON.parse(readFileSync(hostSettingsPath(), "utf8")) as PersistedHostSettings;
  } catch {
    return { turnUrls: "", livekitServerUrl: "", easyTierPeers: [] };
  }
}

function decryptSecrets(settings: PersistedHostSettings): HostSettingsSecrets {
  if (!settings.encryptedSecrets || !safeStorage.isEncryptionAvailable()) return {};
  try {
    return JSON.parse(
      safeStorage.decryptString(Buffer.from(settings.encryptedSecrets, "base64")),
    ) as HostSettingsSecrets;
  } catch {
    return {};
  }
}

function parsePeerList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\r\n,;；]+/)
    .map((peer) => peer.trim())
    .filter(Boolean)
    .slice(0, 16);
}

function hostSettingsPath(): string {
  return join(app.getPath("userData"), "host-settings.json");
}

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: "#0c1110",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const configuredDevServerUrl = process.env.VITE_DEV_SERVER_URL?.trim();
  const devServerUrl = resolveDevServerUrl(configuredDevServerUrl, app.isPackaged);
  if (configuredDevServerUrl && !devServerUrl) {
    console.warn(
      `[gamecast] ignoring VITE_DEV_SERVER_URL (${configuredDevServerUrl}): ` +
        "only loopback http is allowed, and never in a packaged build",
    );
  }
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, targetUrl) => {
    const currentUrl = window.webContents.getURL();
    if (targetUrl !== currentUrl) event.preventDefault();
  });
  if (devServerUrl) await window.loadURL(devServerUrl);
  else await window.loadFile(join(__dirname, "../dist/index.html"));
}

app.on("second-instance", (_event, argv) => {
  const protocolUrl = extractProtocolUrl(argv);
  if (protocolUrl) dispatchProtocolUrl(protocolUrl);
  else {
    const window = BrowserWindow.getAllWindows()[0];
    if (window?.isMinimized()) window.restore();
    window?.show();
    window?.focus();
  }
});

app.whenReady().then(async () => {
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient("gamecast", process.execPath, [process.argv[1]]);
  } else {
    app.setAsDefaultProtocolClient("gamecast");
  }
  pendingProtocolUrl = extractProtocolUrl(process.argv);
  diagnostics = new DiagnosticsService(app.getPath("userData"), app.getPath("desktop"), {
    appVersion: app.getVersion(),
    platform: process.platform,
    release: release(),
    arch: arch(),
    electronVersion: process.versions.electron ?? "unknown",
    chromeVersion: process.versions.chrome ?? "unknown",
    nodeVersion: process.versions.node,
  });
  networkAdapter = new EmbeddedEasyTierAdapter({
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    userDataPath: app.getPath("userData"),
    log: (line) => diagnostics?.log({ scope: "network", event: "easytier.output", data: { line } }),
  });
  diagnostics.log({ scope: "app", event: "started" });
  registerDiagnosticHandlers();
  registerCaptureHandlers();
  registerHostHandlers();
  registerNativeMediaHandlers();
  registerAppHandlers();
  await createWindow();
  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on("window-all-closed", async () => {
  diagnostics?.log({ scope: "app", event: "window-all-closed" });
  await nativeMedia.stop().catch(() => undefined);
  await networkAdapter?.stop().catch(() => undefined);
  await stopHostedServer().catch(() => undefined);
  await diagnostics?.close().catch(() => undefined);
  if (process.platform !== "darwin") app.quit();
});
