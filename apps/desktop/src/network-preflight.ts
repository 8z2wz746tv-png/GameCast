import type {
  ControlServerHealth,
  IceServerConfig,
  NetworkPreflightSession,
} from "@gamecast/contracts";
import { api } from "./api";
import { diagnosticLog, errorDetails } from "./diagnostics";
import { extractCandidateType } from "./p2p/ice-candidate-type";
import type { NetworkAdapterStatus } from "./vite-env";

export type NetworkPreflightVerdict = "ready" | "limited" | "failed";

export type IceCandidateProbe = {
  host: boolean;
  srflx: boolean;
  relay: boolean;
  elapsedMs: number;
  errors: string[];
};

export type NetworkPreflightResult = {
  verdict: NetworkPreflightVerdict;
  controlLatencyMs?: number;
  uploadKbps?: number;
  controlReady: boolean;
  turnConfigured: boolean;
  turnReady: boolean;
  stunReady: boolean;
  sfuAvailable: boolean;
  easyTierReady: boolean;
  firewallEnabled?: boolean;
  candidateProbe?: IceCandidateProbe;
  summary: string;
  details: string[];
};

export async function runNetworkPreflight(): Promise<NetworkPreflightResult> {
  const startedAt = performance.now();
  let health: ControlServerHealth;
  let session: NetworkPreflightSession;
  let localStatus: Awaited<ReturnType<NonNullable<typeof window.electronAPI>["getLocalNetworkPreflight"]>> | undefined;
  try {
    [health, session, localStatus] = await Promise.all([
      api.health(),
      api.networkPreflight(),
      window.electronAPI?.getLocalNetworkPreflight().catch(() => undefined),
    ]);
  } catch (error) {
    diagnosticLog("network-preflight", "control.failed", errorDetails(error), "error");
    return {
      verdict: "failed",
      controlReady: false,
      turnConfigured: false,
      turnReady: false,
      stunReady: false,
      sfuAvailable: false,
      easyTierReady: false,
      summary: "无法连接控制节点",
      details: [error instanceof Error ? error.message : "控制节点没有响应"],
    };
  }

  const controlLatencyMs = Math.max(1, Math.round(performance.now() - startedAt));
  const [candidateProbe, uploadKbps] = await Promise.all([
    probeIceCandidates(session.p2p.iceServers),
    api.measureUploadKbps().catch(() => undefined),
  ]);
  const turnConfigured = session.p2p.iceServers.some((server) =>
    server.urls.some((url) => /^turns?:/i.test(url)),
  );
  const easyTierReady = localStatus?.networkStatus.state === "connected";
  const directCandidateReady = candidateProbe.srflx || easyTierReady;
  const details = [
    `控制节点响应 ${controlLatencyMs} ms`,
    uploadKbps ? `实测上传到控制节点 ${(uploadKbps / 1000).toFixed(1)} Mbps` : "上传速度检测未完成",
    candidateProbe.srflx ? "已获取公网直连候选" : "未获取公网直连候选",
    candidateProbe.relay
      ? "TURN 中转候选可用"
      : turnConfigured
        ? "TURN 已配置，但本机未能获取中转候选"
        : "控制节点没有配置 TURN 中转",
    health.sfuAvailable ? "SFU 回退可用" : "SFU 回退未配置",
    easyTierReady ? "EasyTier 虚拟网络已连接" : "EasyTier 虚拟网络未连接",
    ...(localStatus?.firewallEnabled === true ? ["Windows 防火墙已启用"] : []),
    ...candidateProbe.errors.slice(0, 2),
  ];
  const resilient = candidateProbe.relay || health.sfuAvailable || easyTierReady;
  const verdict: NetworkPreflightVerdict = resilient
    ? "ready"
    : directCandidateReady
      ? "limited"
      : "failed";
  const summary = verdict === "ready"
    ? "适合异地连接"
    : verdict === "limited"
      ? "可以尝试直连，但没有可靠中转"
      : "当前网络不适合异地连接";
  if (!candidateProbe.srflx && !easyTierReady) {
    details.push("修复：允许 GameCast 通过 Windows 防火墙，并确认路由器没有封锁 UDP");
  }
  if (turnConfigured && !candidateProbe.relay) {
    details.push("修复：检查 TURN 地址、凭证及服务器 3478/UDP 和中继端口范围");
  } else if (!turnConfigured && !health.sfuAvailable && !easyTierReady) {
    details.push("修复：在高级设置启用内置组网，或让控制节点配置 TURN 中转");
  }
  const result: NetworkPreflightResult = {
    verdict,
    controlLatencyMs,
    uploadKbps,
    controlReady: true,
    turnConfigured,
    turnReady: candidateProbe.relay,
    stunReady: candidateProbe.srflx,
    sfuAvailable: health.sfuAvailable,
    easyTierReady,
    firewallEnabled: localStatus?.firewallEnabled,
    candidateProbe,
    summary,
    details,
  };
  diagnosticLog("network-preflight", "completed", result, verdict === "failed" ? "warn" : "info");
  return result;
}

export async function probeIceCandidates(
  iceServers: IceServerConfig[],
  timeoutMs = 6_000,
): Promise<IceCandidateProbe> {
  const startedAt = performance.now();
  const found = new Set<string>();
  const errors: string[] = [];
  const peer = new RTCPeerConnection({ iceServers });
  peer.createDataChannel("gamecast-preflight", { ordered: false });
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        error ? reject(error) : resolve();
      };
      const timer = window.setTimeout(() => finish(), timeoutMs);
      peer.onicecandidate = (event) => {
        if (!event.candidate) {
          finish();
          return;
        }
        const type = event.candidate.type || extractCandidateType(event.candidate.candidate);
        if (type) found.add(type);
      };
      peer.onicecandidateerror = (event) => {
        const message = `${event.url || "ICE"}: ${event.errorText || event.errorCode}`;
        if (!errors.includes(message)) errors.push(message);
      };
      void peer.createOffer()
        .then((offer) => peer.setLocalDescription(offer))
        .catch((error) => finish(error));
    });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "ICE 候选检测失败");
  } finally {
    peer.close();
  }
  return {
    host: found.has("host"),
    srflx: found.has("srflx"),
    relay: found.has("relay"),
    elapsedMs: Math.max(1, Math.round(performance.now() - startedAt)),
    errors,
  };
}

export function describeNetworkAdapter(status: NetworkAdapterStatus): string {
  if (status.state === "connected") return `EasyTier 已连接${status.virtualIp ? ` · ${status.virtualIp}` : ""}`;
  if (status.state === "failed") return status.lastError ?? "EasyTier 启动失败";
  return "EasyTier 未连接";
}
