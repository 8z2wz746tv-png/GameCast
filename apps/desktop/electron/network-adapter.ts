import { type ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { basename, delimiter, join } from "node:path";
import type { Readable } from "node:stream";

export type NetworkAdapterKind = "direct" | "easytier";
export type NetworkAdapterState = "disabled" | "starting" | "connected" | "stopped" | "failed";

export type EasyTierStartRequest = {
  executablePath?: string;
  networkName: string;
  networkSecret: string;
  peers?: string[];
  virtualIp?: string;
};

export type NetworkAdapterStatus = {
  mode: NetworkAdapterKind;
  state: NetworkAdapterState;
  virtualIp?: string;
  interfaceName?: string;
  pid?: number;
  executablePath?: string;
  networkName?: string;
  peerCount: number;
  lastError?: string;
  recentLogs: string[];
};

type AdapterOptions = {
  resourcesPath: string;
  appPath: string;
  userDataPath: string;
  log?: (line: string) => void;
};

const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 3_000;
const MAX_RECENT_LOGS = 40;

export class EmbeddedEasyTierAdapter {
  private child: EasyTierProcess | undefined;
  private secretToRedact = "";
  private statusValue: NetworkAdapterStatus = createStatus("direct");
  private startPromise: Promise<NetworkAdapterStatus> | undefined;

  constructor(private readonly options: AdapterOptions) {}

  get status(): NetworkAdapterStatus {
    return { ...this.statusValue, recentLogs: [...this.statusValue.recentLogs] };
  }

  async start(request: EasyTierStartRequest): Promise<NetworkAdapterStatus> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal(request).finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.secretToRedact = "";
    if (!child) {
      this.setStatus({ mode: "easytier", state: "stopped", pid: undefined });
      return;
    }
    child.removeAllListeners("exit");
    child.kill();
    await Promise.race([
      onceExit(child),
      new Promise<void>((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS)),
    ]);
    this.setStatus({ mode: "easytier", state: "stopped", pid: undefined });
  }

  async diagnostics(): Promise<{ status: NetworkAdapterStatus; interfaces: NetworkInterfaceSummary[] }> {
    return { status: this.status, interfaces: listNetworkInterfaces() };
  }

  private async startInternal(request: EasyTierStartRequest): Promise<NetworkAdapterStatus> {
    const executablePath = resolveEasyTierExecutable(
      request.executablePath,
      this.options.resourcesPath,
      this.options.appPath,
    );
    if (!executablePath) {
      const message = "未找到 easytier-core.exe，请在设置中填写可执行文件路径";
      this.setStatus({ mode: "easytier", state: "failed", lastError: message });
      throw new Error(message);
    }
    if (!request.networkName.trim() || !request.networkSecret.trim()) {
      const message = "EasyTier 网络名称和网络密钥不能为空";
      this.setStatus({ mode: "easytier", state: "failed", lastError: message });
      throw new Error(message);
    }

    await this.stop();
    const configDir = join(this.options.userDataPath, "easytier");
    mkdirSync(configDir, { recursive: true });
    const args = buildEasyTierArgs({ ...request, executablePath, configDir });
    this.setStatus({
      mode: "easytier",
      state: "starting",
      executablePath,
      networkName: request.networkName.trim(),
      peerCount: request.peers?.length ?? 0,
      recentLogs: [],
      lastError: undefined,
    });
    this.secretToRedact = request.networkSecret.trim();
    const child = spawn(executablePath, args, {
      cwd: configDir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: `${join(this.options.resourcesPath, "native")}${delimiter}${process.env.PATH ?? ""}` },
    });
    this.child = child;
    this.setStatus({ pid: child.pid });
    const onLine = (line: string, level: "stdout" | "stderr") => {
      const text = redactSecret(line.trim(), this.secretToRedact);
      if (!text) return;
      this.appendLog(`${level}: ${text}`);
      this.options.log?.(`easytier ${level}: ${text}`);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => consumeLines(chunk, (line) => onLine(line, "stdout")));
    child.stderr.on("data", (chunk: string) => consumeLines(chunk, (line) => onLine(line, "stderr")));
    child.once("error", (error) => {
      if (this.child !== child) return;
      this.setStatus({ state: "failed", lastError: error.message });
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      if (this.statusValue.state === "starting" || this.statusValue.state === "connected") {
        this.setStatus({ state: "failed", lastError: `EasyTier 进程已退出 (${code ?? signal ?? "unknown"})`, pid: undefined });
      }
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.statusValue.state === "failed") break;
      const found = findEasyTierInterface(request.virtualIp);
      if (found) {
        this.setStatus({ state: "connected", virtualIp: found.address, interfaceName: found.name });
        return this.status;
      }
      await delay(250);
    }
    await this.stop();
    const message = this.statusValue.lastError ?? "EasyTier 启动超时，未检测到虚拟网卡地址";
    this.setStatus({ state: "failed", lastError: message });
    throw new Error(message);
  }

  private appendLog(line: string): void {
    const next = [...this.statusValue.recentLogs, line].slice(-MAX_RECENT_LOGS);
    this.setStatus({ recentLogs: next });
  }

  private setStatus(patch: Partial<NetworkAdapterStatus>): void {
    this.statusValue = { ...this.statusValue, ...patch };
  }
}

export type NetworkInterfaceSummary = {
  name: string;
  address: string;
  family: string;
  internal: boolean;
  kind: "easytier" | "tailscale" | "zerotier" | "wireguard" | "other";
};

export function listNetworkInterfaces(): NetworkInterfaceSummary[] {
  const result: NetworkInterfaceSummary[] = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal || entry.address.startsWith("169.254.")) continue;
      result.push({
        name,
        address: entry.address,
        family: entry.family,
        internal: entry.internal,
        kind: detectNetworkKind(name),
      });
    }
  }
  return result;
}

export function detectNetworkKind(name: string): NetworkInterfaceSummary["kind"] {
  if (/easytier/i.test(name)) return "easytier";
  if (/tailscale/i.test(name)) return "tailscale";
  if (/zerotier/i.test(name)) return "zerotier";
  if (/wireguard|wintun/i.test(name)) return "wireguard";
  return "other";
}

export function findEasyTierInterface(preferredAddress?: string): { name: string; address: string } | undefined {
  const interfaces = listNetworkInterfaces().filter((item) => item.kind === "easytier");
  if (preferredAddress) return interfaces.find((item) => item.address === preferredAddress);
  return interfaces[0];
}

export const EASY_TIER_EXECUTABLE_NAME = "easytier-core.exe";

/**
 * A configured EasyTier path is attacker-reachable: it arrives over `network:start` from the
 * renderer and is also persisted to host-settings.json. It may therefore only ever name the
 * EasyTier core binary — without this check `network:start` degrades into "spawn any file on disk",
 * which turns a renderer compromise into arbitrary host code execution.
 *
 * Backslashes are normalised first so Windows paths are classified correctly on any platform.
 */
export function isEasyTierExecutablePath(value: string): boolean {
  return basename(value.replace(/\\/g, "/")).toLowerCase() === EASY_TIER_EXECUTABLE_NAME;
}

export function resolveEasyTierExecutable(
  configuredPath: string | undefined,
  resourcesPath: string,
  appPath: string,
): string | undefined {
  const candidates = [
    configuredPath?.trim(),
    join(resourcesPath, "native", EASY_TIER_EXECUTABLE_NAME),
    join(appPath, "native", EASY_TIER_EXECUTABLE_NAME),
  ].filter(
    (value): value is string => typeof value === "string" && isEasyTierExecutablePath(value),
  );
  return candidates.find((candidate) => existsSync(candidate));
}

export function buildEasyTierArgs(request: EasyTierStartRequest & { configDir: string }): string[] {
  const args = [
    "--network-name", request.networkName.trim(),
    "--network-secret", request.networkSecret.trim(),
    "--dhcp", "true",
    "--listeners", "11010",
    "--hostname", "GameCast",
    "--instance-name", "gamecast",
    "--config-dir", request.configDir,
    "--rpc-portal", "127.0.0.1:0",
    "--default-protocol", "udp",
  ];
  for (const peer of request.peers ?? []) {
    if (peer.trim()) args.push("--peers", peer.trim());
  }
  return args;
}

function createStatus(mode: NetworkAdapterKind): NetworkAdapterStatus {
  return { mode, state: mode === "direct" ? "disabled" : "stopped", peerCount: 0, recentLogs: [] };
}

function consumeLines(chunk: string, onLine: (line: string) => void): void {
  for (const line of chunk.split(/\r?\n/)) onLine(line);
}

type EasyTierProcess = ChildProcessByStdio<null, Readable, Readable>;

function onceExit(child: EasyTierProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactSecret(value: string, secret: string): string {
  return secret.length >= 4 ? value.split(secret).join("[REDACTED]") : value;
}
