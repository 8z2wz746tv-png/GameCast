import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createSocket, type Socket } from "node:dgram";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import ffmpegStatic from "ffmpeg-static";
import {
  MediaStream,
  MediaStreamTrack,
  RTCPeerConnection,
  type RTCRtpSender,
  type RtpPacket,
  useH264,
  useOPUS,
} from "werift";
import type {
  IceCandidateData,
  IceServerConfig,
  SessionDescriptionData,
  VideoPreset,
} from "@gamecast/contracts";
import {
  matchNativeOutputPreviews,
  resolveNativeOutputIndex,
  type ElectronScreenPreview,
  type NativeOutputCalibration,
} from "./native-output.js";
import { NativeRtpFanout, isNativeRtpStalled } from "./native-rtp-fanout.js";
import { RtpContinuityRewriter } from "./rtp-continuity.js";
import { SerialTaskQueue } from "./serial-task-queue.js";

export type NativeMediaStartRequest = {
  sourceId: string;
  outputIndex?: number;
  preset: VideoPreset;
  maxBitrate: number;
  iceServers: IceServerConfig[];
  allowedHostAddresses: string[];
  audioOffer?: string;
};

export type NativeMediaStartResult = {
  encoder: string;
  width: number;
  height: number;
  frameRate: number;
  bitrateKbps: number;
  hasSystemAudio: boolean;
  audioAnswer?: string;
  audioError?: string;
};

export type NativeMediaEvent =
  | {
      type: "ice";
      connectionId: string;
      candidate: IceCandidateData | null;
    }
  | {
      type: "connection-state";
      connectionId: string;
      state: "new" | "connecting" | "connected" | "disconnected" | "failed" | "closed";
    }
  | {
      type: "publisher-stats";
      encoder: string;
      width: number;
      height: number;
      framesPerSecond: number;
      bitrateKbps: number;
      rtpPackets?: number;
      rtpBytes?: number;
      firstRtpAt?: number;
      lastRtpAt?: number;
      sendQueuePackets?: number;
      sendQueueBytes?: number;
      peakSendQueuePackets?: number;
      sentRtpPackets?: number;
      droppedRtpPackets?: number;
    }
  | {
      type: "encoder-recovery";
      state: "starting" | "succeeded" | "failed";
      attempt: number;
      reason: string;
      message?: string;
    }
  | { type: "error"; message: string };

type NativePeer = {
  connectionId: string;
  pc: RTCPeerConnection;
  videoTrack: MediaStreamTrack;
  videoSender: RTCRtpSender;
  audioTrack?: MediaStreamTrack;
  noRtpTimer?: ReturnType<typeof setTimeout>;
};

type EncoderDefinition = {
  name: "h264_nvenc" | "h264_qsv" | "h264_amf" | "h264_mf";
  label: string;
};

const H264_PAYLOAD_TYPE = 102;
const OPUS_PAYLOAD_TYPE = 111;
const RTP_STALL_THRESHOLD_MS = 4_000;
const RTP_WATCHDOG_INTERVAL_MS = 1_000;
const OUTPUT_PREVIEW_WIDTH = 160;
const OUTPUT_PREVIEW_HEIGHT = 90;

export class NativeMediaService {
  private readonly peers = new Map<string, NativePeer>();
  private readonly operations = new SerialTaskQueue();
  private readonly ffmpegChildren = new Set<ChildProcessWithoutNullStreams>();
  private readonly intentionalFfmpegStops = new WeakSet<ChildProcessWithoutNullStreams>();
  private readonly rtpContinuity = new RtpContinuityRewriter();
  private readonly videoFanout = new NativeRtpFanout((connectionId, error) => {
    if (!this.peers.has(connectionId)) return;
    this.emit({
      type: "error",
      message: `原生视频轨道写入失败：${error instanceof Error ? error.message : String(error)}`,
    });
  });
  private config: NativeMediaStartRequest | undefined;
  private encoder: EncoderDefinition | undefined;
  private ffmpeg: ChildProcessWithoutNullStreams | undefined;
  private rtpSocket: Socket | undefined;
  private audioBridge: RTCPeerConnection | undefined;
  private disposeAudioTrack: (() => void) | undefined;
  private shuttingDown = false;
  private lastFrame = 0;
  private lastFps = 0;
  private rtpPackets = 0;
  private rtpBytes = 0;
  private firstRtpAt = 0;
  private lastRtpAt = 0;
  private lastRtpDiagnosticAt = 0;
  private mediaWatchdog: ReturnType<typeof setInterval> | undefined;
  private recoveryScheduled = false;
  private recoveryCount = 0;

  constructor(private readonly emit: (event: NativeMediaEvent) => void) {}

  async calibrateOutputIndexes(
    screens: ElectronScreenPreview[],
  ): Promise<NativeOutputCalibration> {
    if (screens.length === 1) {
      return {
        reliable: true,
        averageDistance: 0,
        assignmentMargin: 255,
        matches: [{
          sourceId: screens[0]!.sourceId,
          outputIndex: 0,
          distance: 0,
        }],
      };
    }
    if (screens.length < 2 || this.config) {
      return {
        reliable: false,
        averageDistance: 255,
        assignmentMargin: 0,
        matches: [],
      };
    }
    const ffmpegPath = resolveFfmpegPath();
    if (!ffmpegPath) {
      return {
        reliable: false,
        averageDistance: 255,
        assignmentMargin: 0,
        matches: [],
      };
    }
    const probes = await Promise.allSettled(
      screens.map((_, outputIndex) => captureNativeOutputPreview(ffmpegPath, outputIndex)),
    );
    const outputs = probes.flatMap((result, outputIndex) =>
      result.status === "fulfilled" ? [{ outputIndex, ...result.value }] : [],
    );
    const probeErrors = probes.flatMap((result, outputIndex) =>
      result.status === "rejected" ? [`output=${outputIndex}: ${String(result.reason)}`] : [],
    );
    return {
      ...matchNativeOutputPreviews(screens, outputs),
      probeErrors,
    };
  }

  start(request: NativeMediaStartRequest): Promise<NativeMediaStartResult> {
    return this.operations.run(() => this.startExclusive(request));
  }

  private async startExclusive(request: NativeMediaStartRequest): Promise<NativeMediaStartResult> {
    await this.stopExclusive();
    const outputIndex = resolveNativeOutputIndex(request.sourceId, request.outputIndex);
    if (outputIndex === undefined) {
      throw new Error("原生硬件编码当前只支持共享整个屏幕，窗口共享将使用兼容模式");
    }

    this.shuttingDown = false;
    this.config = { ...request, outputIndex };
    const ffmpegPath = resolveFfmpegPath();
    if (!ffmpegPath) {
      throw new Error("没有找到 GameCast 原生媒体运行库");
    }
    const encoders = await probeHardwareEncoders(ffmpegPath);
    if (encoders.length === 0) {
      throw new Error("没有检测到可用的 H.264 硬件编码器");
    }

    const socket = createSocket("udp4");
    this.rtpSocket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(0, "127.0.0.1", () => {
        socket.removeListener("error", reject);
        try {
          socket.setRecvBufferSize(4 * 1024 * 1024);
        } catch {
          // The default buffer remains usable on systems that reject resizing.
        }
        resolve();
      });
    });
    socket.on("message", (packet) => {
      const normalizedPacket = this.rtpContinuity.rewrite(
        packet,
        this.config?.preset.frameRate ?? 60,
      );
      const now = Date.now();
      this.rtpPackets += 1;
      this.rtpBytes += normalizedPacket.byteLength;
      this.firstRtpAt ||= now;
      this.lastRtpAt = now;
      if (now - this.lastRtpDiagnosticAt >= 5_000) {
        this.lastRtpDiagnosticAt = now;
        const fanoutStats = this.videoFanout.snapshot();
        const senderStats = [...this.peers.values()].map((peer) => {
          const outbound = peer.videoSender.collectStats(now)
            .find((stats) => stats.type === "outbound-rtp") as
              | { packetsSent?: number }
              | undefined;
          return outbound?.packetsSent ?? 0;
        });
        this.emit({
          type: "publisher-stats",
          encoder: this.encoder?.label ?? "starting",
          width: this.config?.preset.width ?? 0,
          height: this.config?.preset.height ?? 0,
          framesPerSecond: this.lastFps,
          bitrateKbps: this.config ? Math.round(this.config.maxBitrate / 1000) : 0,
          rtpPackets: this.rtpPackets,
          rtpBytes: this.rtpBytes,
          firstRtpAt: this.firstRtpAt,
          lastRtpAt: this.lastRtpAt,
          sendQueuePackets: 0,
          sendQueueBytes: 0,
          peakSendQueuePackets: 0,
          sentRtpPackets: Math.max(0, ...senderStats),
          droppedRtpPackets: Math.max(0, ...fanoutStats.map((stats) => stats.failedPackets)),
        });
      }
      for (const peer of this.peers.values()) {
        if (peer.noRtpTimer) {
          clearTimeout(peer.noRtpTimer);
          peer.noRtpTimer = undefined;
        }
      }
      this.videoFanout.write(normalizedPacket);
    });

    let lastError: unknown;
    for (const candidate of encoders) {
      try {
        await this.startFfmpeg(ffmpegPath, outputIndex, candidate);
        this.encoder = candidate;
        break;
      } catch (error) {
        lastError = error;
        await this.stopFfmpeg();
      }
    }
    if (!this.encoder) {
      await this.stopExclusive();
      throw lastError instanceof Error
        ? lastError
        : new Error("硬件编码器无法启动");
    }
    this.startMediaWatchdog();

    let audioAnswer: string | undefined;
    let audioError: string | undefined;
    if (request.audioOffer) {
      try {
        audioAnswer = await this.startAudioBridge(request.audioOffer);
      } catch (error) {
        audioError = error instanceof Error ? error.message : String(error);
        await this.audioBridge?.close().catch(() => undefined);
        this.audioBridge = undefined;
      }
    }

    return {
      encoder: this.encoder.label,
      width: request.preset.width,
      height: request.preset.height,
      frameRate: request.preset.frameRate,
      bitrateKbps: Math.round(request.maxBitrate / 1000),
      hasSystemAudio: Boolean(audioAnswer),
      audioAnswer,
      audioError,
    };
  }

  updatePreset(preset: VideoPreset, maxBitrate: number): Promise<NativeMediaStartResult> {
    return this.operations.run(() => this.updatePresetExclusive(preset, maxBitrate));
  }

  private async updatePresetExclusive(
    preset: VideoPreset,
    maxBitrate: number,
  ): Promise<NativeMediaStartResult> {
    const current = this.config;
    if (!current) throw new Error("原生共享尚未启动");
    const outputIndex = resolveNativeOutputIndex(current.sourceId, current.outputIndex);
    if (outputIndex === undefined) throw new Error("无法找到当前共享屏幕的输出编号");
    const next = { ...current, preset, maxBitrate, outputIndex, audioOffer: undefined };
    await this.stopFfmpeg();
    await delay(250);
    this.config = next;
    const ffmpegPath = resolveFfmpegPath();
    if (!ffmpegPath || outputIndex === undefined || !this.encoder) {
      throw new Error("无法重新配置原生编码器");
    }
    try {
      await this.startFfmpeg(ffmpegPath, outputIndex, this.encoder);
    } catch (error) {
      await this.stopFfmpeg().catch(() => undefined);
      await delay(500);
      this.config = current;
      await this.startFfmpeg(ffmpegPath, outputIndex, this.encoder).catch(() => undefined);
      throw error;
    }
    return {
      encoder: this.encoder.label,
      width: preset.width,
      height: preset.height,
      frameRate: preset.frameRate,
      bitrateKbps: Math.round(maxBitrate / 1000),
      hasSystemAudio: Boolean(this.audioBridge),
    };
  }

  async createOffer(connectionId: string): Promise<SessionDescriptionData> {
    const config = this.config;
    if (!config || !this.encoder) throw new Error("原生共享尚未启动");
    await this.closePeer(connectionId);

    const pc = new RTCPeerConnection({
      codecs: {
        video: [
          useH264({
            payloadType: H264_PAYLOAD_TYPE,
            parameters:
              "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e033",
          }),
        ],
        audio: [useOPUS({ payloadType: OPUS_PAYLOAD_TYPE })],
      },
      iceServers: config.iceServers.map((server) => ({
        urls: server.urls,
        username: server.username,
        credential: server.credential,
      })),
      iceInterfaceAddresses: config.allowedHostAddresses[0]
        ? { udp4: config.allowedHostAddresses[0] }
        : undefined,
      iceAdditionalHostAddresses: config.allowedHostAddresses,
      iceUseIpv4: true,
      iceUseIpv6: false,
    });
    const stream = new MediaStream({ id: `gamecast-${connectionId}` });
    const videoTrack = new MediaStreamTrack({ kind: "video" });
    stream.addTrack(videoTrack);
    const videoSender = pc.addTrack(videoTrack, stream);
    let audioTrack: MediaStreamTrack | undefined;
    if (this.audioBridge) {
      audioTrack = new MediaStreamTrack({ kind: "audio" });
      stream.addTrack(audioTrack);
      pc.addTrack(audioTrack, stream);
    }
    const peer: NativePeer = {
      connectionId,
      pc,
      videoTrack,
      videoSender,
      audioTrack,
    };
    this.videoFanout.add(connectionId, (packet) => videoTrack.writeRtp(packet));
    peer.noRtpTimer = setTimeout(() => {
      const current = this.peers.get(connectionId);
      const forwarded = this.videoFanout.stats(connectionId)?.forwardedPackets ?? 0;
      if (current !== peer || forwarded > 0 || this.shuttingDown) return;
      this.emit({ type: "connection-state", connectionId, state: "failed" });
      void this.closePeer(connectionId);
    }, 10_000);
    this.peers.set(connectionId, peer);

    pc.onIceCandidate.subscribe((candidate) => {
      const data = candidate?.toJSON();
      this.emit({
        type: "ice",
        connectionId,
        candidate: data
          ? {
              candidate: data.candidate,
              sdpMid: data.sdpMid,
              sdpMLineIndex: data.sdpMLineIndex,
              usernameFragment: data.usernameFragment,
            }
          : null,
      });
    });
    pc.connectionStateChange.subscribe((state) => {
      this.emit({ type: "connection-state", connectionId, state });
    });

    const offer = await pc.createOffer();
    const applyingLocalDescription = pc.setLocalDescription(offer);
    await waitForLocalDescription(pc, applyingLocalDescription, 1_000);
    const local = pc.localDescription;
    if (!local) throw new Error("无法生成原生 WebRTC Offer");
    void applyingLocalDescription.catch((error) => {
      if (this.peers.get(connectionId) !== peer) return;
      this.emit({
        type: "error",
        message: `原生 ICE 候选收集失败：${error instanceof Error ? error.message : String(error)}`,
      });
    });
    return { type: "offer", sdp: local.sdp };
  }

  async setAnswer(connectionId: string, answer: SessionDescriptionData): Promise<void> {
    const peer = this.peers.get(connectionId);
    if (!peer) return;
    await peer.pc.setRemoteDescription({ type: answer.type, sdp: answer.sdp });
  }

  async addIceCandidate(connectionId: string, candidate: IceCandidateData | null): Promise<void> {
    const peer = this.peers.get(connectionId);
    if (!peer) return;
    await peer.pc.addIceCandidate(candidate ?? null);
  }

  async closePeer(connectionId: string): Promise<void> {
    const peer = this.peers.get(connectionId);
    if (!peer) return;
    this.peers.delete(connectionId);
    if (peer.noRtpTimer) clearTimeout(peer.noRtpTimer);
    peer.noRtpTimer = undefined;
    this.videoFanout.remove(connectionId);
    peer.videoTrack.stop();
    peer.audioTrack?.stop();
    await closeWeriftPeer(peer.pc);
  }

  stop(): Promise<void> {
    return this.operations.run(() => this.stopExclusive());
  }

  private async stopExclusive(): Promise<void> {
    this.shuttingDown = true;
    if (this.mediaWatchdog) clearInterval(this.mediaWatchdog);
    this.mediaWatchdog = undefined;
    for (const connectionId of [...this.peers.keys()]) await this.closePeer(connectionId);
    this.videoFanout.clear();
    this.disposeAudioTrack?.();
    this.disposeAudioTrack = undefined;
    await this.audioBridge?.close().catch(() => undefined);
    this.audioBridge = undefined;
    await this.stopFfmpeg();
    this.rtpSocket?.close();
    this.rtpSocket = undefined;
    this.config = undefined;
    this.encoder = undefined;
    this.lastFrame = 0;
    this.lastFps = 0;
    this.rtpPackets = 0;
    this.rtpBytes = 0;
    this.firstRtpAt = 0;
    this.lastRtpAt = 0;
    this.lastRtpDiagnosticAt = 0;
    this.recoveryScheduled = false;
    this.recoveryCount = 0;
    this.rtpContinuity.reset();
  }

  private startMediaWatchdog(): void {
    if (this.mediaWatchdog) clearInterval(this.mediaWatchdog);
    this.mediaWatchdog = setInterval(() => {
      if (this.shuttingDown || this.recoveryScheduled) return;
      if (!isNativeRtpStalled({
        now: Date.now(),
        lastRtpAt: this.lastRtpAt,
        peerCount: this.peers.size,
        thresholdMs: RTP_STALL_THRESHOLD_MS,
      })) return;
      this.recoveryScheduled = true;
      void this.operations.run(() => this.recoverEncoderExclusive()).finally(() => {
        this.recoveryScheduled = false;
      });
    }, RTP_WATCHDOG_INTERVAL_MS);
  }

  private async recoverEncoderExclusive(): Promise<void> {
    if (this.shuttingDown || !this.config || !this.encoder || this.peers.size === 0) return;
    if (!isNativeRtpStalled({
      now: Date.now(),
      lastRtpAt: this.lastRtpAt,
      peerCount: this.peers.size,
      thresholdMs: RTP_STALL_THRESHOLD_MS,
    })) return;
    const ffmpegPath = resolveFfmpegPath();
    const outputIndex = resolveNativeOutputIndex(this.config.sourceId, this.config.outputIndex);
    const encoder = this.encoder;
    if (!ffmpegPath || outputIndex === undefined) return;
    this.recoveryCount += 1;
    const attempt = this.recoveryCount;
    this.emit({
      type: "encoder-recovery",
      state: "starting",
      attempt,
      reason: "rtp-source-stalled",
    });
    try {
      await this.stopFfmpeg();
      await delay(150);
      await this.startFfmpeg(ffmpegPath, outputIndex, encoder);
      this.emit({
        type: "encoder-recovery",
        state: "succeeded",
        attempt,
        reason: "rtp-source-stalled",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({
        type: "encoder-recovery",
        state: "failed",
        attempt,
        reason: "rtp-source-stalled",
        message,
      });
      this.emit({ type: "error", message: `原生视频自动恢复失败：${message}` });
    }
  }

  private async startAudioBridge(offerSdp: string): Promise<string> {
    const pc = new RTCPeerConnection({
      codecs: { audio: [useOPUS({ payloadType: OPUS_PAYLOAD_TYPE })], video: [] },
      iceServers: [],
      iceInterfaceAddresses: { udp4: "127.0.0.1" },
      iceAdditionalHostAddresses: ["127.0.0.1"],
      iceUseIpv4: true,
      iceUseIpv6: false,
    });
    this.audioBridge = pc;
    pc.onTrack.subscribe((track) => {
      if (track.kind !== "audio") return;
      this.disposeAudioTrack?.();
      this.disposeAudioTrack = track.onReceiveRtp.subscribe((packet: RtpPacket) => {
        for (const peer of this.peers.values()) peer.audioTrack?.writeRtp(packet.clone());
      }).unSubscribe;
    });
    await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    const local = pc.localDescription;
    if (!local) throw new Error("无法建立系统声音桥接");
    return local.sdp;
  }

  private async startFfmpeg(
    ffmpegPath: string,
    outputIndex: number,
    encoder: EncoderDefinition,
  ): Promise<void> {
    const config = this.config;
    const socket = this.rtpSocket;
    if (!config || !socket) throw new Error("原生媒体服务尚未初始化");
    const address = socket.address();
    if (typeof address === "string") throw new Error("无法分配本机 RTP 端口");
    const args = buildFfmpegArgs(config, outputIndex, encoder, address.port);
    this.rtpContinuity.markDiscontinuity();
    const child = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.ffmpegChildren.add(child);
    child.stdout.resume();
    this.ffmpeg = child;
    let errorLog = "";
    let startupComplete = false;
    child.once("exit", (code) => {
      this.ffmpegChildren.delete(child);
      if (this.ffmpeg === child) this.ffmpeg = undefined;
      if (
        startupComplete &&
        !this.shuttingDown &&
        !this.intentionalFfmpegStops.has(child) &&
        code !== 0
      ) {
        this.emit({ type: "error", message: formatFfmpegError(encoder.label, errorLog) });
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      errorLog = `${errorLog}${chunk}`.slice(-8_000);
      this.readProgress(chunk);
    });
    const firstPacket = new Promise<void>((resolve, reject) => {
      const onPacket = () => {
        cleanup();
        resolve();
      };
      const onExit = () => {
        cleanup();
        reject(new Error(formatFfmpegError(encoder.label, errorLog)));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`${encoder.label} 启动后没有输出视频帧`));
      }, 8_000);
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeListener("message", onPacket);
        child.removeListener("exit", onExit);
      };
      socket.once("message", onPacket);
      child.once("exit", onExit);
    });
    await firstPacket;
    startupComplete = true;
  }

  private readProgress(chunk: string): void {
    const config = this.config;
    const encoder = this.encoder;
    if (!config || !encoder) return;
    for (const line of chunk.split(/\r?\n/)) {
      const [key, value] = line.split("=", 2);
      if (key === "frame") this.lastFrame = Number(value) || this.lastFrame;
      if (key === "fps") this.lastFps = Number(value) || this.lastFps;
      if (key !== "progress") continue;
      this.emit({
        type: "publisher-stats",
        encoder: encoder.label,
        width: config.preset.width,
        height: config.preset.height,
        framesPerSecond: this.lastFps,
        bitrateKbps: Math.round(config.maxBitrate / 1000),
      });
    }
  }

  private async stopFfmpeg(): Promise<void> {
    const children = [...this.ffmpegChildren];
    if (children.length === 0) {
      this.ffmpeg = undefined;
      return;
    }
    for (const child of children) this.intentionalFfmpegStops.add(child);
    await Promise.all(children.map((child) => stopChildProcess(child)));
    if (children.includes(this.ffmpeg!)) this.ffmpeg = undefined;
  }
}

async function stopChildProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let failureTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (forceTimer) clearTimeout(forceTimer);
      if (failureTimer) clearTimeout(failureTimer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
    };
    const onExit = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    child.once("exit", onExit);
    child.once("error", onError);
    forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      failureTimer = setTimeout(() => {
        cleanup();
        reject(new Error(`无法结束旧的视频采集进程（PID ${child.pid ?? "unknown"}）`));
      }, 2_000);
    }, 1_000);
    if (!child.stdin.destroyed) {
      child.stdin.write("q\n", (error) => {
        if (error && child.exitCode === null && child.signalCode === null) child.kill();
      });
    } else {
      child.kill();
    }
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForLocalDescription(
  pc: RTCPeerConnection,
  applying: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pc.localDescription && Date.now() < deadline) await delay(10);
  if (!pc.localDescription) await applying;
}

async function closeWeriftPeer(pc: RTCPeerConnection): Promise<void> {
  await Promise.race([
    pc.close().catch(() => undefined),
    delay(500),
  ]);
}

function buildFfmpegArgs(
  request: NativeMediaStartRequest,
  outputIndex: number,
  encoder: EncoderDefinition,
  port: number,
): string[] {
  const bitrate = Math.max(1_000_000, request.maxBitrate);
  const bitrateText = `${Math.round(bitrate / 1000)}k`;
  const bufferText = `${Math.round(bitrate / 2000)}k`;
  const filter = [
    "hwdownload",
    "format=bgra",
    `scale=${request.preset.width}:${request.preset.height}:flags=fast_bilinear`,
  ];
  const common = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-nostats",
    "-stats_period",
    "1",
    "-progress",
    "pipe:2",
    "-f",
    "lavfi",
    "-i",
    `ddagrab=output_idx=${outputIndex}:framerate=${request.preset.frameRate}:draw_mouse=1`,
    "-vf",
    filter.join(","),
    "-an",
    "-c:v",
    encoder.name,
  ];
  const encoderArgs = (() => {
    switch (encoder.name) {
      case "h264_nvenc":
        return [
          "-preset", "p1", "-tune", "ull", "-rc", "cbr", "-profile:v", "baseline",
          "-level", "5.1", "-bf", "0", "-zerolatency", "1", "-forced-idr", "1",
        ];
      case "h264_qsv":
        return [
          "-preset", "veryfast", "-low_power", "1", "-look_ahead", "0", "-async_depth", "2",
          "-profile:v", "baseline", "-level", "5.1", "-bf", "0",
        ];
      case "h264_amf":
        return ["-usage", "ultralowlatency", "-quality", "speed", "-rc", "cbr", "-bf", "0"];
      case "h264_mf":
        return ["-rate_control", "cbr", "-scenario", "video_conference"];
    }
  })();
  return [
    ...common,
    ...encoderArgs,
    "-b:v", bitrateText,
    "-maxrate", bitrateText,
    "-bufsize", bufferText,
    // Late joiners need a decodable keyframe. Repeat SPS/PPS on each keyframe
    // because the RTP socket is shared and packets from before a peer joined
    // are intentionally not replayed.
    "-g", String(Math.max(1, Math.round(request.preset.frameRate))),
    "-keyint_min", String(Math.max(1, Math.round(request.preset.frameRate))),
    "-force_key_frames", "expr:gte(t,n_forced*1)",
    "-bsf:v", "dump_extra=freq=keyframe",
    "-f", "rtp",
    "-payload_type", String(H264_PAYLOAD_TYPE),
    `rtp://127.0.0.1:${port}?pkt_size=1200`,
  ];
}

async function probeHardwareEncoders(ffmpegPath: string): Promise<EncoderDefinition[]> {
  const [filters, encoders] = await Promise.all([
    runFfmpegProbe(ffmpegPath, ["-hide_banner", "-filters"]),
    runFfmpegProbe(ffmpegPath, ["-hide_banner", "-encoders"]),
  ]);
  if (!/\bddagrab\b/i.test(filters)) {
    throw new Error("当前 FFmpeg 运行库不支持 Desktop Duplication 采集");
  }
  const definitions: EncoderDefinition[] = [
    { name: "h264_nvenc", label: "NVIDIA NVENC" },
    { name: "h264_qsv", label: "Intel Quick Sync" },
    { name: "h264_amf", label: "AMD AMF" },
    { name: "h264_mf", label: "Windows Media Foundation" },
  ];
  return definitions.filter((definition) => new RegExp(`\\b${definition.name}\\b`).test(encoders));
}

function runFfmpegProbe(ffmpegPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let output = "";
    const append = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-2_000_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("检测原生媒体运行库超时"));
    }, 8_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(output);
    });
  });
}

function captureNativeOutputPreview(
  ffmpegPath: string,
  outputIndex: number,
): Promise<{ width: number; height: number; pixels: Uint8Array }> {
  const expectedBytes = OUTPUT_PREVIEW_WIDTH * OUTPUT_PREVIEW_HEIGHT * 4;
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `ddagrab=output_idx=${outputIndex}:framerate=5:draw_mouse=0`,
    "-vf",
    `hwdownload,format=bgra,scale=${OUTPUT_PREVIEW_WIDTH}:${OUTPUT_PREVIEW_HEIGHT}:flags=fast_bilinear`,
    "-frames:v",
    "1",
    "-pix_fmt",
    "bgra",
    "-f",
    "rawvideo",
    "pipe:1",
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let errorLog = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      const pixels = Buffer.concat(chunks, bytes).subarray(0, expectedBytes);
      if (pixels.byteLength !== expectedBytes) {
        reject(new Error(
          `DXGI 输出 ${outputIndex} 预览数据不完整：${errorLog.trim()}`,
        ));
        return;
      }
      resolve({
        width: OUTPUT_PREVIEW_WIDTH,
        height: OUTPUT_PREVIEW_HEIGHT,
        pixels,
      });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (bytes >= expectedBytes) return;
      chunks.push(chunk);
      bytes += chunk.byteLength;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      errorLog = `${errorLog}${chunk}`.slice(-4_000);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      finish(code === 0 ? undefined : new Error(
        `DXGI 输出 ${outputIndex} 无法捕获：${errorLog.trim()}`,
      ));
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`DXGI 输出 ${outputIndex} 预览捕获超时`));
    }, 8_000);
  });
}

function resolveFfmpegPath(): string | undefined {
  const candidates = [
    process.env.GAMECAST_FFMPEG_PATH,
    app.isPackaged ? join(process.resourcesPath, "native", "ffmpeg.exe") : undefined,
    getStaticFfmpegPath(),
    findJianyingFfmpeg(),
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
}

function getStaticFfmpegPath(): string | undefined {
  const value: unknown = ffmpegStatic;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "default" in value) {
    const nested = (value as { default?: unknown }).default;
    return typeof nested === "string" ? nested : undefined;
  }
  return undefined;
}

function findJianyingFfmpeg(): string | undefined {
  if (app.isPackaged || !process.env.LOCALAPPDATA) return undefined;
  const appsPath = join(process.env.LOCALAPPDATA, "JianyingPro", "Apps");
  try {
    const versions = readdirSync(appsPath).sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    for (const version of versions) {
      const path = join(appsPath, version, "ffmpeg.exe");
      if (existsSync(path)) return path;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function formatFfmpegError(encoder: string, log: string): string {
  const useful = log
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /error|failed|invalid|device|cannot|could not/i.test(line))
    .slice(-3)
    .join("; ");
  return useful ? `${encoder} 启动失败：${useful}` : `${encoder} 启动失败`;
}
