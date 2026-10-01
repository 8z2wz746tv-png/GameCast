import type {
  IceCandidateData,
  MediaTransport,
  P2PSession,
  ServerSignalMessage,
  ShareDescriptor,
  VideoPreset,
} from "@gamecast/contracts";
import {
  diagnosticLog,
  errorDetails,
  summarizeIceCandidate,
  summarizeSdp,
} from "../diagnostics";
import {
  getConnectionRecoveryAction,
  getPendingConnectionFailureAction,
} from "./connection-recovery-policy";
import {
  describeDisplayCaptureFailure,
  displayCaptureErrorMessage,
  isSystemAudioCaptureFailure,
  shouldUseNativeScreenCapture,
} from "./display-capture-error";
import { IceCandidateBuffer } from "./ice-candidate-buffer";
import { InboundMediaStallDetector } from "./inbound-stall-detector";
import {
  getEffectiveQualityPolicy,
  isCaptureTargetMet,
  isIceCandidateAllowed,
} from "./quality-policy";
import type { SfuFallback } from "./sfu-fallback";
import type { SignalingClient } from "./signaling-client";

export type MediaStats = {
  transport: MediaTransport;
  width?: number;
  height?: number;
  framesPerSecond?: number;
  bitrateKbps?: number;
  roundTripTimeMs?: number;
  encoder?: string;
};

export type MediaConnectionStage = {
  phase: "idle" | "direct" | "turn" | "sfu" | "recovering" | "connected" | "failed";
  message: string;
  expiresAt?: number;
  attempt?: number;
};

export type P2PMediaCallbacks = {
  onStream: (
    connectionId: string,
    participantId: string,
    stream: MediaStream,
    transport: MediaTransport,
  ) => void;
  onStreamCleared: (connectionId: string) => void;
  onLocalShareChanged: (
    stream: MediaStream | undefined,
    hasSystemAudio: boolean,
    active?: boolean,
    captureMode?: "browser" | "native",
    encoder?: string,
  ) => void;
  onConnectionCommitted: (participantId: string, transport: MediaTransport) => void;
  onError: (message: string) => void;
  onStats: (stats: MediaStats | undefined) => void;
  onPublisherStats: (stats: MediaStats | undefined) => void;
  onConnectionStage: (stage: MediaConnectionStage) => void;
};

type OutgoingConnection = {
  connectionId: string;
  viewerId: string;
  pc: RTCPeerConnection;
  videoSender?: RTCRtpSender;
  currentBitrate: number;
  unhealthySamples: number;
  healthySince?: number;
};

type IncomingConnection = {
  connectionId: string;
  targetParticipantId: string;
  pc: RTCPeerConnection;
  stream: MediaStream;
  ready: boolean;
  transport: MediaTransport;
  timeout?: ReturnType<typeof setTimeout>;
  readinessTimer?: ReturnType<typeof setInterval>;
  disconnectTimer?: ReturnType<typeof setTimeout>;
  previousBytes?: number;
  previousStatsAt?: number;
  stallDetector: InboundMediaStallDetector;
  attempt: number;
  requestReason: "selection" | "media-stalled";
  keyFrameRequestedAt?: number;
  fallbackRequested?: boolean;
};

const MAX_INITIAL_P2P_ATTEMPTS = 2;
const P2P_RETRY_DELAY_MS = 300;

export class P2PMediaManager {
  private readonly outgoing = new Map<string, OutgoingConnection>();
  private readonly nativeOutgoing = new Map<string, string>();
  private readonly incoming = new Map<string, IncomingConnection>();
  private readonly pendingCandidates = new IceCandidateBuffer<IceCandidateData | null>();
  private readonly sfuConnections = new Set<string>();
  private localStream: MediaStream | undefined;
  private nativeMode = false;
  private nativePolicySignature: string | undefined;
  private nativePolicyTimer: ReturnType<typeof setTimeout> | undefined;
  private nativeAudioPeer: RTCPeerConnection | undefined;
  private auxiliaryCaptureReduced = false;
  private shareStartPromise: Promise<void> | undefined;
  private captureEndedTrack: MediaStreamTrack | undefined;
  private captureEndedHandler: (() => void) | undefined;
  private disposeNativeEvents: (() => void) | undefined;
  private requestedPreset: VideoPreset;
  private reportedViewerCount = 0;
  private pendingConnectionId: string | undefined;
  private activeConnectionId: string | undefined;
  private displayedConnectionId: string | undefined;
  private desiredTargetId: string | undefined;
  private monitorTimer: ReturnType<typeof setInterval>;
  private lastIncomingDiagnosticAt = 0;
  private lastPublisherDiagnosticAt = 0;
  private stallRecoveryCooldownUntil = 0;
  private statsSampling = false;
  private connectionRetryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly selfParticipantId: string,
    private readonly p2pSession: P2PSession,
    private readonly signaling: SignalingClient,
    private readonly allowedHostAddresses: string[],
    private readonly sfu: SfuFallback,
    private readonly callbacks: P2PMediaCallbacks,
    initialPreset: VideoPreset,
  ) {
    this.requestedPreset = initialPreset;
    diagnosticLog("media", "manager.created", {
      participantId: selfParticipantId,
      iceServerCount: p2pSession.iceServers.length,
      allowedHostAddresses,
      connectionTimeoutSeconds: p2pSession.connectionTimeoutSeconds,
      sfuAvailable: sfu.available,
    });
    this.monitorTimer = setInterval(() => void this.sampleMediaStats(), 2_000);
    this.disposeNativeEvents = window.electronAPI?.onNativeMediaEvent((event) => {
      switch (event.type) {
        case "ice": {
          const viewerId = this.nativeOutgoing.get(event.connectionId);
          if (!viewerId) return;
          diagnosticLog("native-peer", "ice.local", {
            connectionId: event.connectionId,
            ...summarizeIceCandidate(event.candidate),
          });
          try {
            this.signaling.send({
              type: "rtc.ice",
              connectionId: event.connectionId,
              targetParticipantId: viewerId,
              candidate: event.candidate,
            });
          } catch {
            // The signaling reconnect path reports room connectivity failures.
          }
          return;
        }
        case "connection-state": {
          const viewerId = this.nativeOutgoing.get(event.connectionId);
          diagnosticLog("native-peer", "connection-state", {
            connectionId: event.connectionId,
            state: event.state,
            viewerId,
          }, event.state === "failed" ? "error" : "info");
          if (event.state === "failed" && viewerId) {
            // Only the viewer may request fallback. Closing the failed publisher
            // peer lets the viewer's timeout create a completely fresh relation.
            this.closeOutgoing(event.connectionId);
          }
          return;
        }
        case "publisher-stats":
          this.callbacks.onPublisherStats({ transport: "p2p", ...event });
          if (Date.now() - this.lastPublisherDiagnosticAt >= 5_000) {
            this.lastPublisherDiagnosticAt = Date.now();
            diagnosticLog("native-media", "publisher.stats", event);
          }
          return;
        case "encoder-recovery":
          diagnosticLog(
            "native-media",
            "encoder.recovery",
            event,
            event.state === "failed" ? "error" : event.state === "starting" ? "warn" : "info",
          );
          return;
        case "error":
          diagnosticLog("native-media", "runtime.error", { message: event.message }, "error");
          this.callbacks.onError(event.message);
      }
    });
  }

  get stream(): MediaStream | undefined {
    return this.localStream;
  }

  startSharing(sourceId: string, preset: VideoPreset): Promise<void> {
    if (this.shareStartPromise) return this.shareStartPromise;
    const operation = this.startSharingExclusive(sourceId, preset).finally(() => {
      if (this.shareStartPromise === operation) this.shareStartPromise = undefined;
    });
    this.shareStartPromise = operation;
    return operation;
  }

  private async startSharingExclusive(sourceId: string, preset: VideoPreset): Promise<void> {
    const sourceKind = sourceId.startsWith("screen:") ? "screen" : "window";
    const useNativeScreenCapture = shouldUseNativeScreenCapture(sourceId, Boolean(window.electronAPI));
    diagnosticLog("media", "share.start.requested", {
      sourceKind,
      preset: preset.name,
      width: preset.width,
      height: preset.height,
      frameRate: preset.frameRate,
    });
    if (window.electronAPI) await window.electronAPI.selectCaptureSource(sourceId);
    await this.stopSharing(false);
    this.requestedPreset = preset;
    let stream: MediaStream;
    let audioCaptureError: unknown;
    const videoConstraints: MediaTrackConstraints = useNativeScreenCapture
      ? {
          width: { ideal: 320, max: 320 },
          height: { ideal: 180, max: 180 },
          frameRate: { ideal: 5, max: 5 },
        }
      : {
          width: { ideal: preset.width, max: preset.width },
          height: { ideal: preset.height, max: preset.height },
          frameRate: {
            ideal: preset.frameRate,
            max: preset.frameRate,
          },
        };
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: videoConstraints,
        audio: true,
      });
    } catch (error) {
      if (!window.electronAPI || !isSystemAudioCaptureFailure(error)) {
        diagnosticLog("media", "capture.failed", errorDetails(error), "error");
        throw new Error(describeDisplayCaptureFailure(error, sourceKind, preset));
      }
      audioCaptureError = error;
      diagnosticLog("media", "capture.audio-retry", errorDetails(error), "warn");
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: videoConstraints,
          audio: false,
        });
      } catch (retryError) {
        diagnosticLog("media", "capture.video-only-retry-failed", errorDetails(retryError), "error");
        throw new Error(describeDisplayCaptureFailure(retryError, sourceKind, preset));
      }
    }
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) {
      stream.getTracks().forEach((track) => {
        track.stop();
      });
      throw new Error("没有获取到屏幕画面");
    }
    videoTrack.contentHint = "motion";
    diagnosticLog("media", "capture.started", {
      video: videoTrack.getSettings(),
      videoReadyState: videoTrack.readyState,
      audioTracks: stream.getAudioTracks().map((track) => ({
        label: track.label,
        readyState: track.readyState,
        muted: track.muted,
      })),
    });
    const handleCaptureEnded = () => {
      if (this.localStream === stream) void this.stopSharing();
    };
    videoTrack.addEventListener("ended", handleCaptureEnded);
    this.captureEndedTrack = videoTrack;
    this.captureEndedHandler = handleCaptureEnded;
    this.localStream = stream;
    try {
      // Chromium is only an auxiliary audio/preview source for native whole-screen
      // sharing. The native capture result below is the authoritative quality check.
      if (useNativeScreenCapture) {
        await this.applyReducedAuxiliaryCapture(videoTrack).catch((error) => {
          diagnosticLog(
            "media",
            "auxiliary-capture.initial-reduction-failed",
            errorDetails(error),
            "warn",
          );
        });
      } else {
        await this.applyCapturePolicy(true);
      }
    } catch (error) {
      this.localStream = undefined;
      this.detachCaptureEndedHandler();
      stream.getTracks().forEach((track) => {
        track.stop();
      });
      throw error;
    }
    const capturedSystemAudio = stream.getAudioTracks().length > 0;
    if (useNativeScreenCapture && window.electronAPI) {
      try {
        const audioOffer = capturedSystemAudio
          ? await this.createNativeAudioOffer(stream)
          : undefined;
        const policy = getEffectiveQualityPolicy(this.requestedPreset, 1);
        const native = await window.electronAPI.startNativeMedia({
          sourceId,
          preset: policy.preset,
          maxBitrate: policy.maxBitrate,
          iceServers: this.p2pSession.iceServers,
          allowedHostAddresses: this.allowedHostAddresses,
          audioOffer,
        });
        if (!isCaptureTargetMet(native, policy.preset)) {
          throw new Error(
            `${policy.preset.label} ${policy.preset.frameRate}fps，原生捕获实测为 ${native.width}x${native.height} @ ${native.frameRate}fps`,
          );
        }
        diagnosticLog("native-media", "start.completed", {
          encoder: native.encoder,
          captureBackend: native.captureBackend,
          pipeline: native.pipeline,
          width: native.width,
          height: native.height,
          frameRate: native.frameRate,
          bitrateKbps: native.bitrateKbps,
          hasSystemAudio: native.hasSystemAudio,
          audioError: native.audioError,
        });
        let nativeSystemAudio = native.hasSystemAudio;
        let audioBridgeError = native.audioError;
        if (native.audioAnswer && this.nativeAudioPeer) {
          try {
            await this.nativeAudioPeer.setRemoteDescription({
              type: "answer",
              sdp: native.audioAnswer,
            });
          } catch (error) {
            nativeSystemAudio = false;
            audioBridgeError = error instanceof Error ? error.message : "无法应用本机音频桥接应答";
            this.nativeAudioPeer.close();
            this.nativeAudioPeer = undefined;
          }
        }
        this.nativeMode = true;
        this.nativePolicySignature = `${native.width}x${native.height}:${native.bitrateKbps}`;
        const nativeEncoderLabel = formatNativeEncoderLabel(native);
        // Keep the capture session alive for loopback audio and SFU fallback. This
        // video track is not attached to native P2P peers, so Chromium does not encode it.
        this.callbacks.onLocalShareChanged(
          stream,
          nativeSystemAudio,
          true,
          "native",
          nativeEncoderLabel,
        );
        this.callbacks.onPublisherStats({
          transport: "p2p",
          width: native.width,
          height: native.height,
          framesPerSecond: native.frameRate,
          bitrateKbps: native.bitrateKbps,
          encoder: nativeEncoderLabel,
        });
        await this.updateAuxiliaryCaptureQuality();
        this.signaling.send({
          type: "share.start",
          preset: preset.name,
          hasSystemAudio: nativeSystemAudio,
        });
        if (capturedSystemAudio && !nativeSystemAudio) {
          this.callbacks.onError(
            `硬件视频编码已启动，但系统声音桥接失败${audioBridgeError ? `：${audioBridgeError}` : ""}`,
          );
        }
        if (audioCaptureError) {
          this.callbacks.onError(
            `画面共享已开始，但系统声音捕获失败：${displayCaptureErrorMessage(audioCaptureError)}`,
          );
        }
        return;
      } catch (error) {
        diagnosticLog("native-media", "start.failed", errorDetails(error), "error");
        this.nativeMode = false;
        this.nativePolicySignature = undefined;
        this.nativeAudioPeer?.close();
        this.nativeAudioPeer = undefined;
        await window.electronAPI.stopNativeMedia().catch(() => undefined);
        const reason = error instanceof Error ? error.message : "未知错误";
        this.callbacks.onError(`原生硬件编码启动失败，已回退兼容模式：${reason}`);
      }
      try {
        await this.applyCapturePolicy(true);
      } catch (error) {
        this.localStream = undefined;
        this.detachCaptureEndedHandler();
        stream.getTracks().forEach((track) => {
          track.stop();
        });
        throw error;
      }
    }
    diagnosticLog("media", "share.browser-fallback", {
      capturedSystemAudio,
      video: videoTrack.getSettings(),
    }, "warn");
    this.callbacks.onLocalShareChanged(stream, capturedSystemAudio, true, "browser");
    this.signaling.send({
      type: "share.start",
      preset: preset.name,
      hasSystemAudio: capturedSystemAudio,
    });
    if (audioCaptureError) {
      this.callbacks.onError(
        `画面共享已开始，但系统声音捕获失败：${displayCaptureErrorMessage(audioCaptureError)}`,
      );
    }
  }

  async updatePreset(preset: VideoPreset): Promise<void> {
    const previousPreset = this.requestedPreset;
    this.requestedPreset = preset;
    if (this.nativeMode && window.electronAPI) {
      if (this.nativePolicyTimer) clearTimeout(this.nativePolicyTimer);
      this.nativePolicyTimer = undefined;
      try {
        const policy = getEffectiveQualityPolicy(preset, Math.max(1, this.reportedViewerCount));
        const result = await window.electronAPI.updateNativeMediaPreset(
          policy.preset,
          policy.maxBitrate,
        );
        this.nativePolicySignature = `${result.width}x${result.height}:${result.bitrateKbps}`;
        this.callbacks.onLocalShareChanged(
          this.localStream,
          result.hasSystemAudio,
          true,
          "native",
          formatNativeEncoderLabel(result),
        );
        await this.updateAuxiliaryCaptureQuality();
        this.signaling.send({
          type: "share.start",
          preset: preset.name,
          hasSystemAudio: result.hasSystemAudio,
        });
        return;
      } catch (error) {
        this.requestedPreset = previousPreset;
        throw error;
      }
    }
    try {
      await this.applyCapturePolicy(Boolean(this.localStream));
    } catch (error) {
      this.requestedPreset = previousPreset;
      await this.applyCapturePolicy(false).catch(() => undefined);
      throw error;
    }
    if (this.localStream) {
      this.signaling.send({
        type: "share.start",
        preset: preset.name,
        hasSystemAudio: this.localStream.getAudioTracks().length > 0,
      });
    }
  }

  async stopSharing(notifyServer = true): Promise<void> {
    diagnosticLog("media", "share.stop", {
      notifyServer,
      nativeMode: this.nativeMode,
      outgoingPeers: this.outgoing.size,
      nativeOutgoingPeers: this.nativeOutgoing.size,
    });
    const stream = this.localStream;
    this.localStream = undefined;
    this.detachCaptureEndedHandler();
    stream?.getTracks().forEach((track) => {
      track.stop();
    });
    for (const connection of [...this.outgoing.values()]) this.closeOutgoing(connection.connectionId);
    for (const connectionId of [...this.nativeOutgoing.keys()]) this.closeOutgoing(connectionId);
    this.sfuConnections.clear();
    await this.sfu.unpublish().catch(() => undefined);
    await window.electronAPI?.stopNativeMedia().catch(() => undefined);
    this.nativeAudioPeer?.close();
    this.nativeAudioPeer = undefined;
    this.nativeMode = false;
    this.nativePolicySignature = undefined;
    this.auxiliaryCaptureReduced = false;
    if (this.nativePolicyTimer) clearTimeout(this.nativePolicyTimer);
    this.nativePolicyTimer = undefined;
    this.callbacks.onLocalShareChanged(undefined, false, false);
    this.callbacks.onPublisherStats(undefined);
    if (notifyServer) {
      try {
        this.signaling.send({ type: "share.stop" });
      } catch {
        // The room may already be closing.
      }
    }
  }

  selectShare(share: ShareDescriptor): void {
    this.cancelConnectionRetry();
    diagnosticLog("viewer", "share.selected", {
      targetParticipantId: share.participantId,
      local: share.participantId === this.selfParticipantId,
      preset: share.preset,
      hasSystemAudio: share.hasSystemAudio,
      viewerCount: share.viewerCount,
    });
    const pendingTarget = this.pendingConnectionId
      ? this.incoming.get(this.pendingConnectionId)?.targetParticipantId
      : undefined;
    const activeTarget = this.activeConnectionId
      ? this.incoming.get(this.activeConnectionId)?.targetParticipantId
      : undefined;
    if (
      share.participantId === this.desiredTargetId &&
      (pendingTarget === share.participantId || activeTarget === share.participantId)
    ) {
      diagnosticLog("viewer", "share.selection-ignored", {
        targetParticipantId: share.participantId,
        reason: pendingTarget ? "pending" : "active",
      });
      return;
    }
    this.desiredTargetId = share.participantId;
    if (share.participantId === this.selfParticipantId) {
      void this.updateAuxiliaryCaptureQuality();
      this.releaseRemoteWatches();
      if (this.localStream) {
        const connectionId = `local-${this.selfParticipantId}`;
        this.displayedConnectionId = connectionId;
        this.callbacks.onStream(connectionId, this.selfParticipantId, this.localStream, "p2p");
        this.callbacks.onConnectionCommitted(this.selfParticipantId, "p2p");
      }
      return;
    }
    void this.updateAuxiliaryCaptureQuality();

    this.requestIncomingConnection(share.participantId, "selection");
  }

  private requestIncomingConnection(
    targetParticipantId: string,
    reason: "selection" | "media-stalled",
    attempt = 1,
  ): void {
    this.cancelConnectionRetry();
    if (this.pendingConnectionId) this.releaseConnection(this.pendingConnectionId);
    const connectionId = crypto.randomUUID();
    this.pendingConnectionId = connectionId;
    const hasTurn = this.hasTurnServer();
    const phase = reason === "media-stalled"
      ? "recovering"
      : attempt > 1 && hasTurn
        ? "turn"
        : "direct";
    this.callbacks.onConnectionStage({
      phase,
      message: reason === "media-stalled"
        ? "画面停滞，正在自动恢复"
        : phase === "turn"
          ? "直连未成功，正在尝试 TURN 中转"
          : hasTurn
            ? "正在尝试 P2P 直连，并准备 TURN 备用链路"
            : "正在尝试 P2P 直连",
      expiresAt: Date.now() + this.p2pSession.connectionTimeoutSeconds * 1000,
      attempt,
    });
    diagnosticLog("viewer", "watch.requested", {
      connectionId,
      targetParticipantId,
      reason,
      attempt,
      timeoutSeconds: this.p2pSession.connectionTimeoutSeconds,
    });
    this.signaling.send({
      type: "watch.request",
      connectionId,
      targetParticipantId,
    });
    const timeout = setTimeout(() => {
      if (this.pendingConnectionId !== connectionId) return;
      diagnosticLog("viewer", "watch.timeout", {
        connectionId,
        targetParticipantId,
        reason,
      }, "warn");
      const record = this.incoming.get(connectionId);
      if (record) this.handlePendingConnectionFailure(record, "timeout");
    }, this.p2pSession.connectionTimeoutSeconds * 1000);
    this.incoming.set(connectionId, {
      connectionId,
      targetParticipantId,
      pc: this.createPeerConnection(
        connectionId,
        targetParticipantId,
        attempt > 1 && hasTurn,
      ),
      stream: new MediaStream(),
      ready: false,
      transport: "p2p",
      timeout,
      stallDetector: new InboundMediaStallDetector(4_000),
      attempt,
      requestReason: reason,
    });
  }

  setViewerCount(viewerCount: number): void {
    this.reportedViewerCount = viewerCount;
    if (this.nativeMode && window.electronAPI) {
      const policy = getEffectiveQualityPolicy(this.requestedPreset, Math.max(1, viewerCount));
      const signature = `${policy.preset.width}x${policy.preset.height}:${Math.round(policy.maxBitrate / 1000)}`;
      if (this.nativePolicyTimer) clearTimeout(this.nativePolicyTimer);
      if (signature !== this.nativePolicySignature) {
        const previousSignature = this.nativePolicySignature;
        this.nativePolicyTimer = setTimeout(() => {
          this.nativePolicyTimer = undefined;
          if (!this.nativeMode || !window.electronAPI) return;
          this.nativePolicySignature = signature;
          void window.electronAPI
            .updateNativeMediaPreset(policy.preset, policy.maxBitrate)
            .then((result) => {
              this.nativePolicySignature = `${result.width}x${result.height}:${result.bitrateKbps}`;
              this.callbacks.onPublisherStats({
                transport: "p2p",
                width: result.width,
                height: result.height,
                framesPerSecond: result.frameRate,
                bitrateKbps: result.bitrateKbps,
                encoder: result.encoder,
              });
            })
            .catch((error) => {
              this.nativePolicySignature = previousSignature;
              this.callbacks.onError(
              error instanceof Error ? error.message : "原生编码器画质调整失败",
              );
            });
        }, 350);
      }
      return;
    }
    void this.applyCapturePolicy(false).catch((error) => {
      this.callbacks.onError(error instanceof Error ? error.message : "无法调整共享画质");
    });
    for (const connection of this.outgoing.values()) void this.applySenderBitrate(connection);
  }

  handleShareStopped(participantId: string): void {
    const affected = [...this.incoming.values()].filter(
      (connection) => connection.targetParticipantId === participantId,
    );
    for (const connection of affected) this.releaseConnection(connection.connectionId);
    if (this.desiredTargetId === participantId) {
      this.cancelConnectionRetry();
      this.desiredTargetId = undefined;
      this.callbacks.onConnectionStage({ phase: "idle", message: "未选择共享画面" });
      this.callbacks.onError("当前共享已经结束");
    }
  }

  async handleSignal(message: ServerSignalMessage): Promise<void> {
    switch (message.type) {
      case "watch.pending":
        diagnosticLog("viewer", "watch.pending", {
          connectionId: message.connectionId,
          targetParticipantId: message.targetParticipantId,
          transport: message.transport,
        });
        if (message.transport === "sfu") {
          // The server selected SFU for this audience size. Close the speculative
          // P2P socket while keeping the watch pending for LiveKit.
          this.closeIncoming(message.connectionId, true);
        }
        return;
      case "watch.requested":
        await this.createOutgoing(message.connectionId, message.viewer.id);
        return;
      case "rtc.offer":
        await this.handleOffer(
          message.connectionId,
          message.participantId,
          message.description,
        );
        return;
      case "rtc.answer":
        await this.handleAnswer(message.connectionId, message.description);
        return;
      case "rtc.ice":
        await this.handleRemoteCandidate(message.connectionId, message.candidate);
        return;
      case "watch.committed":
        this.handleCommitted(message.connectionId, message.targetParticipantId, message.transport);
        return;
      case "watch.released":
        this.closeOutgoing(message.connectionId);
        this.closeIncoming(message.connectionId);
        this.sfuConnections.delete(message.connectionId);
        return;
      case "watch.rejected":
        this.closeIncoming(message.connectionId);
        if (this.pendingConnectionId === message.connectionId) this.pendingConnectionId = undefined;
        this.callbacks.onError(message.reason);
        this.callbacks.onConnectionStage({ phase: "failed", message: message.reason });
        return;
      case "sfu.publish-requested":
        await this.publishSfuFallback(message.connectionId, message.viewer.id);
        return;
      case "sfu.ready":
        await this.subscribeSfuFallback(message.connectionId, message.targetParticipantId);
        return;
      case "sfu.unpublish-requested":
        this.sfuConnections.clear();
        await this.sfu.unpublish();
        await this.updateAuxiliaryCaptureQuality();
        return;
      case "error":
        if (message.connectionId && this.pendingConnectionId === message.connectionId) {
          this.releaseConnection(message.connectionId);
        }
        this.callbacks.onError(message.message);
        if (message.connectionId) {
          this.callbacks.onConnectionStage({ phase: "failed", message: message.message });
        }
        return;
      default:
        return;
    }
  }

  async close(): Promise<void> {
    clearInterval(this.monitorTimer);
    this.disposeNativeEvents?.();
    this.disposeNativeEvents = undefined;
    this.releaseRemoteWatches();
    this.pendingCandidates.clear();
    await this.stopSharing(false);
    await this.sfu.disconnect();
  }

  retrySelectedShare(): void {
    if (!this.desiredTargetId) return;
    this.requestIncomingConnection(this.desiredTargetId, "selection");
  }

  private async createNativeAudioOffer(stream: MediaStream): Promise<string | undefined> {
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) return undefined;
    this.nativeAudioPeer?.close();
    const pc = new RTCPeerConnection();
    this.nativeAudioPeer = pc;
    pc.addTrack(audioTrack, stream);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc, 3_000);
    return pc.localDescription?.sdp;
  }

  private detachCaptureEndedHandler(track?: MediaStreamTrack): void {
    const activeTrack = this.captureEndedTrack;
    const handler = this.captureEndedHandler;
    if ((!track || activeTrack === track) && activeTrack && handler) {
      activeTrack.removeEventListener("ended", handler);
      this.captureEndedTrack = undefined;
      this.captureEndedHandler = undefined;
    }
  }

  private async createOutgoing(connectionId: string, viewerId: string): Promise<void> {
    diagnosticLog("publisher", "peer.create", {
      connectionId,
      viewerId,
      nativeMode: this.nativeMode,
    });
    if (this.nativeMode && window.electronAPI) {
      this.closeOutgoing(connectionId);
      this.nativeOutgoing.set(connectionId, viewerId);
      try {
        const offer = await window.electronAPI.createNativeMediaOffer(connectionId);
        diagnosticLog("publisher", "native.offer.created", {
          connectionId,
          description: summarizeSdp(offer),
        });
        this.signaling.send({
          type: "rtc.offer",
          connectionId,
          targetParticipantId: viewerId,
          description: offer,
        });
      } catch (error) {
        diagnosticLog("publisher", "native.offer.failed", {
          connectionId,
          ...errorDetails(error),
        }, "error");
        this.nativeOutgoing.delete(connectionId);
        await window.electronAPI.closeNativeMediaPeer(connectionId).catch(() => undefined);
        throw error;
      }
      return;
    }
    const stream = this.localStream;
    if (!stream) return;
    this.closeOutgoing(connectionId);
    const pc = this.createPeerConnection(connectionId, viewerId);
    const record: OutgoingConnection = {
      connectionId,
      viewerId,
      pc,
      currentBitrate: getEffectiveQualityPolicy(
        this.requestedPreset,
        Math.max(1, this.reportedViewerCount),
      ).maxBitrate,
      unhealthySamples: 0,
    };
    this.outgoing.set(connectionId, record);
    for (const track of stream.getTracks()) {
      const sender = pc.addTrack(track, stream);
      if (track.kind === "video") {
        record.videoSender = sender;
        this.preferH264(pc, sender);
      }
    }
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    diagnosticLog("publisher", "browser.offer.created", {
      connectionId,
      description: summarizeSdp({ type: offer.type, sdp: offer.sdp }),
    });
    await this.applySenderBitrate(record);
    this.signaling.send({
      type: "rtc.offer",
      connectionId,
      targetParticipantId: viewerId,
      description: { type: "offer", sdp: offer.sdp ?? "" },
    });
    await this.flushCandidates(connectionId, pc);
  }

  private async handleOffer(
    connectionId: string,
    participantId: string,
    description: { type: "offer" | "answer"; sdp: string },
  ): Promise<void> {
    diagnosticLog("viewer", "offer.received", {
      connectionId,
      participantId,
      description: summarizeSdp(description),
    });
    let record = this.incoming.get(connectionId);
    if (!record) {
      record = {
        connectionId,
        targetParticipantId: participantId,
        pc: this.createPeerConnection(connectionId, participantId),
        stream: new MediaStream(),
        ready: false,
        transport: "p2p",
        stallDetector: new InboundMediaStallDetector(4_000),
        attempt: 1,
        requestReason: "selection",
      };
      this.incoming.set(connectionId, record);
    }
    this.configureIncoming(record);
    await record.pc.setRemoteDescription(description);
    await this.flushCandidates(connectionId, record.pc);
    const answer = await record.pc.createAnswer();
    await record.pc.setLocalDescription(answer);
    diagnosticLog("viewer", "answer.created", {
      connectionId,
      description: summarizeSdp({ type: answer.type, sdp: answer.sdp }),
    });
    this.signaling.send({
      type: "rtc.answer",
      connectionId,
      targetParticipantId: participantId,
      description: { type: "answer", sdp: answer.sdp ?? "" },
    });
  }

  private async handleAnswer(
    connectionId: string,
    description: { type: "offer" | "answer"; sdp: string },
  ): Promise<void> {
    diagnosticLog("publisher", "answer.received", {
      connectionId,
      description: summarizeSdp(description),
      native: this.nativeOutgoing.has(connectionId),
    });
    if (this.nativeOutgoing.has(connectionId) && window.electronAPI) {
      await window.electronAPI.setNativeMediaAnswer(connectionId, description);
      return;
    }
    const record = this.outgoing.get(connectionId);
    if (!record) return;
    await record.pc.setRemoteDescription(description);
    await this.flushCandidates(connectionId, record.pc);
  }

  private configureIncoming(record: IncomingConnection): void {
    record.pc.ontrack = (event) => {
      diagnosticLog("viewer", "track.received", {
        connectionId: record.connectionId,
        kind: event.track.kind,
        id: event.track.id,
        muted: event.track.muted,
        readyState: event.track.readyState,
        streamCount: event.streams.length,
      });
      const tracks = event.streams[0]?.getTracks() ?? [event.track];
      for (const track of tracks) {
        if (!record.stream.getTracks().some((candidate) => candidate.id === track.id)) {
          record.stream.addTrack(track);
        }
      }
      if (event.track.kind !== "video") return;
      const activate = () => {
        diagnosticLog("viewer", "video-track.unmuted", {
          connectionId: record.connectionId,
          readyState: event.track.readyState,
        });
        this.waitForFirstDecodedFrame(record);
      };
      event.track.addEventListener("mute", () => {
        diagnosticLog("viewer", "video-track.muted", {
          connectionId: record.connectionId,
          readyState: event.track.readyState,
        }, "warn");
      });
      event.track.addEventListener("ended", () => {
        diagnosticLog("viewer", "video-track.ended", {
          connectionId: record.connectionId,
        }, "warn");
      });
      event.track.addEventListener("unmute", activate, { once: true });
      if (!event.track.muted) setTimeout(activate, 0);
    };
  }

  private waitForFirstDecodedFrame(record: IncomingConnection): void {
    if (record.ready || record.readinessTimer) return;
    const check = async () => {
      if (!this.incoming.has(record.connectionId) || record.ready) return;
      const stats = await record.pc.getStats().catch(() => undefined);
      if (!stats) return;
      let firstFrame: Record<string, unknown> | undefined;
      stats.forEach((report) => {
        if (
          report.type === "inbound-rtp" &&
          report.kind === "video" &&
          ((report.framesDecoded ?? 0) > 0 ||
            ((report.frameWidth ?? 0) > 0 && (report.frameHeight ?? 0) > 0))
        ) {
          firstFrame = {
            framesReceived: report.framesReceived,
            framesDecoded: report.framesDecoded,
            keyFramesDecoded: report.keyFramesDecoded,
            frameWidth: report.frameWidth,
            frameHeight: report.frameHeight,
          };
        }
      });
      if (!firstFrame) return;
      if (record.readinessTimer) clearInterval(record.readinessTimer);
      record.readinessTimer = undefined;
      diagnosticLog("viewer", "first-frame.decoded", {
        connectionId: record.connectionId,
        ...firstFrame,
      });
      await this.activateIncoming(record);
    };
    record.readinessTimer = setInterval(() => void check(), 250);
    void check();
  }

  private async activateIncoming(record: IncomingConnection): Promise<void> {
    if (record.ready || this.pendingConnectionId !== record.connectionId) return;
    record.ready = true;
    if (record.readinessTimer) clearInterval(record.readinessTimer);
    record.readinessTimer = undefined;
    if (record.timeout) clearTimeout(record.timeout);
    record.transport = await this.detectTransport(record.pc);
    diagnosticLog("viewer", "stream.activated", {
      connectionId: record.connectionId,
      targetParticipantId: record.targetParticipantId,
      transport: record.transport,
      tracks: record.stream.getTracks().map((track) => ({
        kind: track.kind,
        id: track.id,
        muted: track.muted,
        readyState: track.readyState,
      })),
    });
    this.displayedConnectionId = record.connectionId;
    this.callbacks.onStream(
      record.connectionId,
      record.targetParticipantId,
      record.stream,
      record.transport,
    );
    this.callbacks.onConnectionStage({
      phase: "connected",
      message: record.transport === "turn" ? "已通过 TURN 中转连接" : "P2P 直连成功",
    });
    this.signaling.send({
      type: "watch.commit",
      connectionId: record.connectionId,
      transport: record.transport,
    });
  }

  private handleCommitted(
    connectionId: string,
    targetParticipantId: string,
    transport: MediaTransport,
  ): void {
    diagnosticLog("media", "watch.committed", {
      connectionId,
      targetParticipantId,
      transport,
    });
    const outgoing = this.outgoing.get(connectionId);
    if ((outgoing || this.nativeOutgoing.has(connectionId)) && transport === "sfu") {
      this.closeOutgoing(connectionId);
    }
    const isViewer = this.pendingConnectionId === connectionId || this.incoming.has(connectionId);
    if (!isViewer) return;
    const previous = this.activeConnectionId;
    this.activeConnectionId = connectionId;
    this.pendingConnectionId = undefined;
    if (previous && previous !== connectionId) this.closeIncoming(previous);
    for (const candidate of [...this.incoming.keys()]) {
      if (candidate !== connectionId && candidate !== previous) this.closeIncoming(candidate);
    }
    this.callbacks.onConnectionCommitted(targetParticipantId, transport);
  }

  private async publishSfuFallback(connectionId: string, viewerId: string): Promise<void> {
    if (!this.localStream || !this.sfu.available) {
      this.callbacks.onError("收到 SFU 回退请求，但当前没有可用的 SFU");
      return;
    }
    const policy = getEffectiveQualityPolicy(
      this.requestedPreset,
      Math.max(1, this.reportedViewerCount),
    );
    await this.updateAuxiliaryCaptureQuality(true);
    this.sfuConnections.add(connectionId);
    try {
      await this.sfu.publish(this.localStream, policy.preset, policy.maxBitrate);
      if (!this.sfuConnections.has(connectionId)) return;
      this.signaling.send({
        type: "sfu.publisher-ready",
        connectionId,
        targetParticipantId: viewerId,
      });
    } catch (error) {
      this.sfuConnections.delete(connectionId);
      await this.updateAuxiliaryCaptureQuality();
      throw error;
    }
  }

  private async subscribeSfuFallback(
    connectionId: string,
    targetParticipantId: string,
  ): Promise<void> {
    if (this.pendingConnectionId !== connectionId) return;
    this.callbacks.onConnectionStage({ phase: "sfu", message: "正在连接 SFU 备用线路" });
    try {
      const stream = await this.sfu.subscribe(targetParticipantId);
      this.closeIncoming(connectionId, true);
      this.displayedConnectionId = connectionId;
      this.callbacks.onStream(connectionId, targetParticipantId, stream, "sfu");
      this.callbacks.onStats({ transport: "sfu" });
      this.callbacks.onConnectionStage({ phase: "connected", message: "已通过 SFU 连接" });
      this.signaling.send({ type: "watch.commit", connectionId, transport: "sfu" });
    } catch (error) {
      this.callbacks.onError(error instanceof Error ? error.message : "SFU 回退失败");
      this.releaseConnection(connectionId);
    }
  }

  private createPeerConnection(
    connectionId: string,
    targetParticipantId: string,
    forceRelay = false,
  ): RTCPeerConnection {
    const pc = new RTCPeerConnection({
      iceServers: this.p2pSession.iceServers,
      iceTransportPolicy: forceRelay ? "relay" : "all",
    });
    diagnosticLog("webrtc", "peer.created", { connectionId, targetParticipantId, forceRelay });
    pc.onicecandidate = (event) => {
      if (event.candidate && !isIceCandidateAllowed(event.candidate, this.allowedHostAddresses)) {
        diagnosticLog("webrtc", "ice.local.filtered", {
          connectionId,
          ...summarizeIceCandidate(event.candidate),
        });
        return;
      }
      const candidate = event.candidate?.toJSON() as IceCandidateData | undefined;
      diagnosticLog("webrtc", "ice.local", {
        connectionId,
        ...summarizeIceCandidate(candidate ?? null),
      });
      try {
        this.signaling.send({
          type: "rtc.ice",
          connectionId,
          targetParticipantId,
          candidate: candidate ?? null,
        });
      } catch {
        // Signaling reconnect logic will surface the room state.
      }
    };
    pc.onconnectionstatechange = () => {
      diagnosticLog(
        "webrtc",
        "connection-state",
        {
          connectionId,
          targetParticipantId,
          state: pc.connectionState,
          iceConnectionState: pc.iceConnectionState,
          signalingState: pc.signalingState,
        },
        pc.connectionState === "failed" ? "error" : "info",
      );
      if (pc.connectionState !== "failed") return;
      const incoming = this.incoming.get(connectionId);
      if (incoming) this.handleIncomingTransportFailure(incoming, "connection-failed");
    };
    pc.oniceconnectionstatechange = () => {
      diagnosticLog(
        "webrtc",
        "ice-connection-state",
        { connectionId, state: pc.iceConnectionState },
        pc.iceConnectionState === "failed" ? "error" : "info",
      );
      const incoming = this.incoming.get(connectionId);
      if (!incoming) return;
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        if (incoming.disconnectTimer) clearTimeout(incoming.disconnectTimer);
        incoming.disconnectTimer = undefined;
        return;
      }
      if (pc.iceConnectionState === "disconnected" && !incoming.disconnectTimer) {
        incoming.disconnectTimer = setTimeout(() => {
          incoming.disconnectTimer = undefined;
          if (pc.iceConnectionState === "disconnected") {
            this.handleIncomingTransportFailure(incoming, "ice-disconnected");
          }
        }, 4_000);
      }
    };
    pc.onicegatheringstatechange = () => {
      diagnosticLog("webrtc", "ice-gathering-state", {
        connectionId,
        state: pc.iceGatheringState,
      });
    };
    pc.onsignalingstatechange = () => {
      diagnosticLog("webrtc", "signaling-state", {
        connectionId,
        state: pc.signalingState,
      });
    };
    pc.onicecandidateerror = (event) => {
      diagnosticLog("webrtc", "ice-candidate-error", {
        connectionId,
        errorCode: event.errorCode,
        errorText: event.errorText,
        url: event.url,
      }, "warn");
    };
    return pc;
  }

  private async handleRemoteCandidate(
    connectionId: string,
    candidate: IceCandidateData | null,
  ): Promise<void> {
    diagnosticLog("webrtc", "ice.remote", {
      connectionId,
      ...summarizeIceCandidate(candidate),
    });
    if (this.nativeOutgoing.has(connectionId) && window.electronAPI) {
      await window.electronAPI.addNativeMediaIceCandidate(connectionId, candidate);
      return;
    }
    const pc = this.outgoing.get(connectionId)?.pc ?? this.incoming.get(connectionId)?.pc;
    if (!pc?.remoteDescription) {
      this.pendingCandidates.push(connectionId, candidate);
      return;
    }
    await pc.addIceCandidate(candidate);
  }

  private async flushCandidates(connectionId: string, pc: RTCPeerConnection): Promise<void> {
    const queue = this.pendingCandidates.take(connectionId);
    for (const candidate of queue) await pc.addIceCandidate(candidate);
  }

  private preferH264(pc: RTCPeerConnection, sender: RTCRtpSender): void {
    const transceiver = pc.getTransceivers().find((candidate) => candidate.sender === sender);
    const codecs = RTCRtpSender.getCapabilities("video")?.codecs;
    if (!transceiver || !codecs) return;
    const h264 = codecs
      .filter((codec) => codec.mimeType.toLowerCase() === "video/h264")
      .sort((left, right) => this.h264HardwareScore(right) - this.h264HardwareScore(left));
    const fallback = codecs.filter((codec) => codec.mimeType.toLowerCase() !== "video/h264");
    if (h264.length > 0) transceiver.setCodecPreferences([...h264, ...fallback]);
  }

  private h264HardwareScore(codec: RTCRtpCodec): number {
    const fmtp = codec.sdpFmtpLine?.toLowerCase() ?? "";
    let score = 0;
    if (fmtp.includes("packetization-mode=1")) score += 4;
    if (fmtp.includes("profile-level-id=42e0")) score += 3;
    else if (fmtp.includes("profile-level-id=4200")) score += 2;
    return score;
  }

  private async applyCapturePolicy(strict = false): Promise<void> {
    const videoTrack = this.localStream?.getVideoTracks()[0];
    if (!videoTrack) return;
    const policy = getEffectiveQualityPolicy(this.requestedPreset, this.reportedViewerCount);
    videoTrack.contentHint = "motion";
    try {
      await videoTrack.applyConstraints({
        width: {
          min: policy.preset.width,
          ideal: policy.preset.width,
          max: policy.preset.width,
        },
        height: {
          min: policy.preset.height,
          ideal: policy.preset.height,
          max: policy.preset.height,
        },
        frameRate: {
          min: policy.preset.frameRate,
          ideal: policy.preset.frameRate,
          max: policy.preset.frameRate,
        },
      });
    } catch {
      if (strict) {
        throw new Error(`${policy.preset.label} ${policy.preset.frameRate}fps 分辨率或帧率无法达到目标值`);
      }
      return;
    }

    if (!strict) return;
    const settings = videoTrack.getSettings();
    const width = settings.width ?? 0;
    const height = settings.height ?? 0;
    const frameRate = settings.frameRate ?? 0;
    if (!isCaptureTargetMet({ width, height, frameRate }, policy.preset)) {
      throw new Error(
        `${policy.preset.label} ${policy.preset.frameRate}fps，当前实测为 ${Math.round(width)}x${Math.round(height)} @ ${Math.round(frameRate)}fps`,
      );
    }
  }

  private async updateAuxiliaryCaptureQuality(forceFullQuality = false): Promise<void> {
    if (!this.nativeMode) return;
    const videoTrack = this.localStream?.getVideoTracks()[0];
    if (videoTrack?.readyState !== "live") return;
    const needsFullQuality = forceFullQuality || this.sfuConnections.size > 0;
    if (needsFullQuality && !this.auxiliaryCaptureReduced) return;
    if (!needsFullQuality && this.auxiliaryCaptureReduced) return;
    try {
      if (needsFullQuality) {
        await this.applyCapturePolicy(false);
        this.auxiliaryCaptureReduced = false;
      } else {
        await this.applyReducedAuxiliaryCapture(videoTrack);
      }
      diagnosticLog("media", "auxiliary-capture.updated", {
        fullQuality: needsFullQuality,
        settings: videoTrack.getSettings(),
      });
    } catch (error) {
      diagnosticLog("media", "auxiliary-capture.update-failed", errorDetails(error), "warn");
    }
  }

  private async applyReducedAuxiliaryCapture(videoTrack: MediaStreamTrack): Promise<void> {
    await videoTrack.applyConstraints({
      width: { ideal: 320, max: 320 },
      height: { ideal: 180, max: 180 },
      frameRate: { ideal: 5, max: 5 },
    });
    this.auxiliaryCaptureReduced = true;
  }

  private async applySenderBitrate(record: OutgoingConnection): Promise<void> {
    const sender = record.videoSender;
    if (!sender) return;
    const policy = getEffectiveQualityPolicy(
      this.requestedPreset,
      Math.max(1, this.reportedViewerCount),
    );
    record.currentBitrate = Math.min(record.currentBitrate, policy.maxBitrate);
    const parameters = sender.getParameters();
    if (parameters.encodings.length === 0) return;
    const encoding = parameters.encodings[0]!;
    encoding.maxBitrate = record.currentBitrate;
    encoding.maxFramerate = policy.preset.frameRate;
    encoding.scaleResolutionDownBy = 1;
    encoding.priority = "high";
    (encoding as RTCRtpEncodingParameters & { networkPriority?: RTCPriorityType })
      .networkPriority = "high";
    parameters.degradationPreference = "maintain-resolution";
    await sender.setParameters(parameters).catch(() => undefined);
  }

  private async adaptOutgoing(record: OutgoingConnection): Promise<void> {
    if (record.pc.connectionState !== "connected") return;
    const policy = getEffectiveQualityPolicy(
      this.requestedPreset,
      Math.max(1, this.reportedViewerCount),
    );
    const stats = await record.pc.getStats();
    let unhealthy = false;
    let remoteVideoStats: Record<string, unknown> | undefined;
    stats.forEach((report) => {
      if (report.type === "remote-inbound-rtp" && report.kind === "video") {
        remoteVideoStats = {
          connectionId: record.connectionId,
          viewerId: record.viewerId,
          fractionLost: report.fractionLost,
          packetsLost: report.packetsLost,
          packetsReceived: report.packetsReceived,
          roundTripTime: report.roundTripTime,
          jitter: report.jitter,
          availableOutgoingBitrate: report.availableOutgoingBitrate,
        };
        if (typeof report.fractionLost === "number" && report.fractionLost > 0.1) unhealthy = true;
      }
      if (
        report.type === "candidate-pair" &&
        report.state === "succeeded" &&
        this.reportedViewerCount > 1 &&
        typeof report.availableOutgoingBitrate === "number" &&
        report.availableOutgoingBitrate > 250_000 &&
        report.availableOutgoingBitrate < record.currentBitrate * 0.3
      ) {
        unhealthy = true;
      }
    });
    if (remoteVideoStats && Date.now() - this.lastPublisherDiagnosticAt >= 5_000) {
      this.lastPublisherDiagnosticAt = Date.now();
      diagnosticLog("publisher", "remote.stats", remoteVideoStats);
    }

    if (unhealthy) {
      record.unhealthySamples += 1;
      record.healthySince = undefined;
      if (record.unhealthySamples >= 5) {
        const minimumByPreset: Record<VideoPreset["name"], number> = {
          "480p": 1_500_000,
          "720p": 3_000_000,
          "1080p": 6_000_000,
          "1440p": 10_000_000,
        };
        const minimumBitrate = Math.min(
          policy.maxBitrate,
          minimumByPreset[policy.preset.name],
        );
        record.currentBitrate = Math.max(
          minimumBitrate,
          Math.floor(record.currentBitrate * 0.85),
        );
        record.unhealthySamples = 0;
        await this.applySenderBitrate(record);
      }
      return;
    }
    record.unhealthySamples = 0;
    record.healthySince ??= Date.now();
    if (Date.now() - record.healthySince >= 8_000 && record.currentBitrate < policy.maxBitrate) {
      record.currentBitrate = Math.min(policy.maxBitrate, Math.floor(record.currentBitrate * 1.5));
      record.healthySince = Date.now();
      await this.applySenderBitrate(record);
    }
  }

  private async sampleMediaStats(): Promise<void> {
    if (this.statsSampling) return;
    this.statsSampling = true;
    try {
      await Promise.allSettled([
        this.monitorActiveConnection(),
        ...[...this.outgoing.values()].map((record) => this.adaptOutgoing(record)),
      ]);
    } finally {
      this.statsSampling = false;
    }
  }

  private async detectTransport(pc: RTCPeerConnection): Promise<MediaTransport> {
    const stats = await pc.getStats();
    let selectedPair: RTCStats | undefined;
    stats.forEach((report) => {
      if (report.type === "transport" && report.selectedCandidatePairId) {
        selectedPair = stats.get(report.selectedCandidatePairId);
      }
      if (report.type === "candidate-pair" && report.nominated && report.state === "succeeded") {
        selectedPair ??= report;
      }
    });
    if (!selectedPair) return "p2p";
    const candidatePair = selectedPair as RTCStats & {
      localCandidateId?: string;
      remoteCandidateId?: string;
    };
    const local = candidatePair.localCandidateId
      ? stats.get(candidatePair.localCandidateId)
      : undefined;
    const remote = candidatePair.remoteCandidateId
      ? stats.get(candidatePair.remoteCandidateId)
      : undefined;
    return local?.candidateType === "relay" || remote?.candidateType === "relay" ? "turn" : "p2p";
  }

  private async monitorActiveConnection(): Promise<void> {
    const monitoredConnectionId = this.activeConnectionId ?? this.pendingConnectionId;
    const active = monitoredConnectionId ? this.incoming.get(monitoredConnectionId) : undefined;
    if (!active) return;
    if (active.pc.connectionState === "failed") {
      this.handleIncomingTransportFailure(active, "monitor-failed");
      return;
    }
    if (active.pc.connectionState !== "connected") return;
    const stats = await active.pc.getStats();
    let result: MediaStats = { transport: active.transport };
    let inboundVideoStats: Record<string, unknown> | undefined;
    let mediaStalled = false;
    let stalledForMs = 0;
    const sampledAt = Date.now();
    stats.forEach((report) => {
      if (report.type === "inbound-rtp" && report.kind === "video") {
        inboundVideoStats = {
          connectionId: active.connectionId,
          targetParticipantId: active.targetParticipantId,
          bytesReceived: report.bytesReceived,
          packetsReceived: report.packetsReceived,
          packetsLost: report.packetsLost,
          framesReceived: report.framesReceived,
          framesDecoded: report.framesDecoded,
          keyFramesDecoded: report.keyFramesDecoded,
          framesDropped: report.framesDropped,
          frameWidth: report.frameWidth,
          frameHeight: report.frameHeight,
          framesPerSecond: report.framesPerSecond,
          jitter: report.jitter,
          totalDecodeTime: report.totalDecodeTime,
          decoderImplementation: report.decoderImplementation,
        };
        result = {
          ...result,
          width: report.frameWidth,
          height: report.frameHeight,
          framesPerSecond: report.framesPerSecond,
        };
        if (active.previousBytes !== undefined && active.previousStatsAt !== undefined) {
          const seconds = (Date.now() - active.previousStatsAt) / 1000;
          result.bitrateKbps = Math.round(
            ((report.bytesReceived - active.previousBytes) * 8) / seconds / 1000,
          );
        }
        active.previousBytes = report.bytesReceived;
        active.previousStatsAt = sampledAt;
        const mediaHealth = active.stallDetector.observe({
          bytesReceived: report.bytesReceived ?? 0,
          framesDecoded: report.framesDecoded ?? 0,
          sampledAt,
        });
        mediaStalled = mediaHealth.stalled;
        stalledForMs = mediaHealth.stalledForMs;
      }
      if (report.type === "candidate-pair" && report.nominated && report.currentRoundTripTime) {
        result.roundTripTimeMs = Math.round(report.currentRoundTripTime * 1000);
      }
    });
    this.callbacks.onStats(result);
    if (!mediaStalled && active.keyFrameRequestedAt) {
      active.keyFrameRequestedAt = undefined;
      this.callbacks.onConnectionStage({
        phase: "connected",
        message: active.transport === "turn" ? "中转画面已恢复" : "直连画面已恢复",
      });
      diagnosticLog("viewer", "media-recovered", {
        connectionId: active.connectionId,
        targetParticipantId: active.targetParticipantId,
      });
    }
    if (
      mediaStalled &&
      active.ready &&
      this.activeConnectionId === active.connectionId &&
      this.displayedConnectionId === active.connectionId &&
      !this.pendingConnectionId &&
      this.desiredTargetId === active.targetParticipantId &&
      sampledAt >= this.stallRecoveryCooldownUntil
    ) {
      if (!active.keyFrameRequestedAt) {
        active.keyFrameRequestedAt = sampledAt;
        this.callbacks.onConnectionStage({
          phase: "recovering",
          message: "检测到画面停滞，正在请求关键帧",
          expiresAt: sampledAt + 4_000,
        });
        diagnosticLog("viewer", "media-stalled", {
          connectionId: active.connectionId,
          targetParticipantId: active.targetParticipantId,
          stalledForMs,
          action: "request-keyframe",
        }, "warn");
        for (const receiver of active.pc.getReceivers()) {
          if (receiver.track?.kind !== "video") continue;
          const requestKeyFrame = (receiver as RTCRtpReceiver & {
            requestKeyFrame?: () => Promise<void> | void;
          }).requestKeyFrame;
          if (requestKeyFrame) void Promise.resolve(requestKeyFrame.call(receiver)).catch(() => undefined);
        }
      } else if (sampledAt - active.keyFrameRequestedAt >= 4_000) {
        this.stallRecoveryCooldownUntil = sampledAt + 20_000;
        diagnosticLog("viewer", "media-stalled", {
          connectionId: active.connectionId,
          targetParticipantId: active.targetParticipantId,
          stalledForMs,
          action: "replace-connection",
        }, "warn");
        this.requestIncomingConnection(active.targetParticipantId, "media-stalled");
      }
    }
    if (Date.now() - this.lastIncomingDiagnosticAt >= 5_000) {
      this.lastIncomingDiagnosticAt = Date.now();
      if (inboundVideoStats) {
        diagnosticLog("viewer", "inbound.stats", {
          ...inboundVideoStats,
          transport: active.transport,
          displayReady: Boolean(this.displayedConnectionId === active.connectionId),
        });
      } else {
        diagnosticLog("viewer", "inbound.video-missing", {
          connectionId: active.connectionId,
          targetParticipantId: active.targetParticipantId,
          receivers: active.pc.getReceivers().map((receiver) => ({
            kind: receiver.track?.kind,
            readyState: receiver.track?.readyState,
            muted: receiver.track?.muted,
          })),
        }, "warn");
      }
    }
  }

  private handleIncomingTransportFailure(
    record: IncomingConnection,
    reason: "connection-failed" | "ice-disconnected" | "monitor-failed",
  ): void {
    if (!this.incoming.has(record.connectionId)) return;
    if (record.disconnectTimer) clearTimeout(record.disconnectTimer);
    record.disconnectTimer = undefined;
    diagnosticLog("viewer", "transport.failed", {
      connectionId: record.connectionId,
      targetParticipantId: record.targetParticipantId,
      reason,
      active: this.activeConnectionId === record.connectionId,
      pending: this.pendingConnectionId === record.connectionId,
    }, "warn");

    const now = Date.now();
    const action = getConnectionRecoveryAction({
      failedConnectionId: record.connectionId,
      targetParticipantId: record.targetParticipantId,
      pendingConnectionId: this.pendingConnectionId,
      activeConnectionId: this.activeConnectionId,
      displayedConnectionId: this.displayedConnectionId,
      desiredTargetId: this.desiredTargetId,
      cooldownUntil: this.stallRecoveryCooldownUntil,
      now,
    });
    if (action === "request-fallback") {
      this.handlePendingConnectionFailure(record, reason);
      return;
    }

    if (action === "replace-active") {
      this.stallRecoveryCooldownUntil = now + 10_000;
      this.requestIncomingConnection(record.targetParticipantId, "media-stalled");
    }
  }

  private releaseRemoteWatches(): void {
    this.cancelConnectionRetry();
    const connections = new Set(
      [this.pendingConnectionId, this.activeConnectionId].filter(
        (connectionId): connectionId is string => Boolean(connectionId),
      ),
    );
    for (const connectionId of connections) this.releaseConnection(connectionId);
    for (const connectionId of [...this.incoming.keys()]) this.closeIncoming(connectionId);
    this.sfu.unsubscribe();
    this.pendingConnectionId = undefined;
    this.activeConnectionId = undefined;
  }

  private handlePendingConnectionFailure(
    record: IncomingConnection,
    cause: "timeout" | "connection-failed" | "ice-disconnected" | "monitor-failed",
  ): void {
    if (record.fallbackRequested) return;
    const action = getPendingConnectionFailureAction({
      attempt: record.attempt,
      maxAttempts: MAX_INITIAL_P2P_ATTEMPTS,
      connectionId: record.connectionId,
      pendingConnectionId: this.pendingConnectionId,
      targetParticipantId: record.targetParticipantId,
      desiredTargetId: this.desiredTargetId,
    });
    if (action === "none") return;
    if (action === "retry-p2p") {
      this.callbacks.onConnectionStage({
        phase: this.hasTurnServer() ? "turn" : "direct",
        message: this.hasTurnServer()
          ? "直连超时，正在切换 TURN 中转"
          : "首次连接超时，正在重新尝试直连",
        attempt: record.attempt + 1,
      });
      diagnosticLog("viewer", "watch.retry-scheduled", {
        connectionId: record.connectionId,
        targetParticipantId: record.targetParticipantId,
        failedAttempt: record.attempt,
        nextAttempt: record.attempt + 1,
        cause,
      }, "warn");
      const { targetParticipantId, requestReason, attempt } = record;
      this.releaseConnection(record.connectionId);
      this.connectionRetryTimer = setTimeout(() => {
        this.connectionRetryTimer = undefined;
        if (
          this.desiredTargetId !== targetParticipantId ||
          this.pendingConnectionId
        ) {
          return;
        }
        this.requestIncomingConnection(targetParticipantId, requestReason, attempt + 1);
      }, P2P_RETRY_DELAY_MS);
      return;
    }

    record.fallbackRequested = true;
    this.callbacks.onConnectionStage({
      phase: this.sfu.available ? "sfu" : "failed",
      message: this.sfu.available
        ? "P2P 与 TURN 均未成功，正在回退 SFU"
        : "直连和中转均不可用",
    });
    diagnosticLog("viewer", "watch.fallback-requested", {
      connectionId: record.connectionId,
      targetParticipantId: record.targetParticipantId,
      attempts: record.attempt,
      cause,
      sfuAvailable: this.sfu.available,
    }, "warn");
    try {
      this.signaling.send({
        type: "p2p.failed",
        connectionId: record.connectionId,
        targetParticipantId: record.targetParticipantId,
      });
    } catch {
      // Signaling reconnection owns the room-level error state.
    }
  }

  private cancelConnectionRetry(): void {
    if (this.connectionRetryTimer) clearTimeout(this.connectionRetryTimer);
    this.connectionRetryTimer = undefined;
  }

  private hasTurnServer(): boolean {
    return this.p2pSession.iceServers.some((server) =>
      server.urls.some((url) => /^turns?:/i.test(url)),
    );
  }

  private releaseConnection(connectionId: string): void {
    diagnosticLog("viewer", "watch.released", { connectionId });
    try {
      this.signaling.send({ type: "watch.release", connectionId });
    } catch {
      // The signaling socket can already be closed during teardown.
    }
    this.closeIncoming(connectionId);
    if (this.displayedConnectionId === connectionId) {
      this.callbacks.onStreamCleared(connectionId);
      this.displayedConnectionId = undefined;
    }
  }

  private closeOutgoing(connectionId: string): void {
    diagnosticLog("publisher", "peer.closed", { connectionId });
    if (this.nativeOutgoing.delete(connectionId)) {
      void window.electronAPI?.closeNativeMediaPeer(connectionId).catch(() => undefined);
      this.pendingCandidates.delete(connectionId);
      return;
    }
    const record = this.outgoing.get(connectionId);
    if (!record) return;
    record.pc.close();
    this.outgoing.delete(connectionId);
    this.pendingCandidates.delete(connectionId);
  }

  private closeIncoming(connectionId: string, preservePending = false): void {
    diagnosticLog("viewer", "peer.closed", { connectionId, preservePending });
    const record = this.incoming.get(connectionId);
    if (!record) return;
    if (record.timeout) clearTimeout(record.timeout);
    if (record.readinessTimer) clearInterval(record.readinessTimer);
    if (record.disconnectTimer) clearTimeout(record.disconnectTimer);
    record.readinessTimer = undefined;
    record.disconnectTimer = undefined;
    record.pc.close();
    this.incoming.delete(connectionId);
    this.pendingCandidates.delete(connectionId);
    if (this.displayedConnectionId === connectionId) {
      this.callbacks.onStreamCleared(connectionId);
      this.displayedConnectionId = undefined;
    }
    if (!preservePending && this.pendingConnectionId === connectionId) {
      this.pendingConnectionId = undefined;
    }
  }
}

function formatNativeEncoderLabel(result: {
  encoder: string;
  captureBackend: "gfxcapture" | "ddagrab";
  pipeline: "gpu" | "compatibility";
}): string {
  if (result.captureBackend === "gfxcapture" && result.pipeline === "gpu") {
    return `${result.encoder} · WGC 零拷贝`;
  }
  if (result.pipeline === "gpu") return `${result.encoder} · GPU 缩放`;
  return `${result.encoder} · 兼容路径`;
}

function waitForIceGathering(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", onStateChange);
      resolve();
    }
    function onStateChange() {
      if (pc.iceGatheringState === "complete") done();
    }
    pc.addEventListener("icegatheringstatechange", onStateChange);
  });
}
