import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  MediaTransport,
  ParticipantSummary,
  RoomSession,
  RoomSnapshot,
  ServerSignalMessage,
  ShareDescriptor,
  VideoPreset,
} from "@gamecast/contracts";
import { getApiBaseUrl } from "./api";
import { VIDEO_PRESETS } from "./media";
import {
  P2PMediaManager,
  type MediaStats,
} from "./p2p/p2p-media-manager";
import {
  createSignalUrl,
  SignalingClient,
  type SignalConnectionState,
} from "./p2p/signaling-client";
import { SfuFallback } from "./p2p/sfu-fallback";
import { diagnosticLog, errorDetails } from "./diagnostics";

export type MediaConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed"
  | "disconnected";

export type RoomSharer = {
  id: string;
  name: string;
  isLocal: boolean;
  preset: ShareDescriptor["preset"];
  hasSystemAudio: boolean;
  viewerCount: number;
};

export function useRoomMedia(session: RoomSession) {
  const [participants, setParticipants] = useState<ParticipantSummary[]>([]);
  const [shares, setShares] = useState<ShareDescriptor[]>([]);
  const [selectedSharerId, setSelectedSharerId] = useState<string | null>(null);
  const [displayedSharerId, setDisplayedSharerId] = useState<string | null>(null);
  const [selectedStream, setSelectedStream] = useState<MediaStream | null>(null);
  const [connectionState, setConnectionState] = useState<MediaConnectionState>("connecting");
  const [transport, setTransport] = useState<MediaTransport | null>(null);
  const [mediaError, setMediaError] = useState("");
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [hasSystemAudio, setHasSystemAudio] = useState(false);
  const [stats, setStats] = useState<MediaStats | undefined>();
  const [publisherStats, setPublisherStats] = useState<MediaStats | undefined>();
  const [captureMode, setCaptureMode] = useState<"browser" | "native" | null>(null);
  const [encoder, setEncoder] = useState<string | undefined>();
  const managerRef = useRef<P2PMediaManager | undefined>(undefined);
  const signalingRef = useRef<SignalingClient | undefined>(undefined);
  const displayedConnectionRef = useRef<string | undefined>(undefined);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const applySnapshot = useCallback((snapshot: RoomSnapshot) => {
    setParticipants(snapshot.participants);
    setShares(snapshot.shares);
    if (snapshot.activeWatch) {
      setSelectedSharerId(snapshot.activeWatch.targetParticipantId);
      setTransport(snapshot.activeWatch.transport);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let manager: P2PMediaManager | undefined;
    diagnosticLog("room", "session.started", {
      participantId: session.participant.id,
      roomId: session.room.id,
      maxParticipants: session.room.limits.maxParticipants,
      maxSharers: session.room.limits.maxSharers,
      maxViewersPerShare: session.room.limits.maxViewersPerShare,
      sfuAvailable: Boolean(session.sfu),
      iceServerCount: session.p2p.iceServers.length,
    });
    const signaling = new SignalingClient(
      createSignalUrl(getApiBaseUrl(), session.signaling.path),
      session.sessionToken,
      session.signaling.reconnectGraceSeconds,
    );
    signalingRef.current = signaling;

    const updateSignalState = (state: SignalConnectionState) => {
      if (disposed) return;
      diagnosticLog("room", "connection-state", { state });
      setConnectionState(state);
      if (state === "connected") setMediaError("");
      if (state === "disconnected") {
        setMediaError("与房间服务的连接已断开，请重新连接");
      }
    };
    signaling.onStateChange = updateSignalState;

    const initialize = async () => {
      const networks = await window.electronAPI?.listNetworkInterfaces().catch(() => []);
      const virtualNetworks = (networks ?? []).filter((network) => network.recommended);
      const allowedHostAddresses = session.p2p.candidatePolicy === "all"
        ? []
        : (virtualNetworks.length > 0 ? virtualNetworks : networks ?? []).map(
            (network) => network.address,
          );
      diagnosticLog("room", "network-policy", {
        discovered: (networks ?? []).map((network) => ({
          name: network.name,
          address: network.address,
          kind: network.kind,
          recommended: network.recommended,
        })),
        allowedHostAddresses,
      });
      const sfu = new SfuFallback(session.sfu);
      manager = new P2PMediaManager(
        session.participant.id,
        session.p2p,
        signaling,
        allowedHostAddresses,
        sfu,
        {
          onStream: (connectionId, participantId, stream, mode) => {
            if (disposed) return;
            diagnosticLog("viewer", "stream.attached-to-state", {
              connectionId,
              participantId,
              transport: mode,
              tracks: stream.getTracks().map((track) => ({
                kind: track.kind,
                id: track.id,
                muted: track.muted,
                readyState: track.readyState,
              })),
            });
            displayedConnectionRef.current = connectionId;
            setSelectedStream(stream);
            setDisplayedSharerId(participantId);
            setTransport(mode);
          },
          onStreamCleared: (connectionId) => {
            if (disposed || displayedConnectionRef.current !== connectionId) return;
            diagnosticLog("viewer", "stream.cleared", { connectionId });
            displayedConnectionRef.current = undefined;
            setSelectedStream(null);
            setDisplayedSharerId(null);
            setStats(undefined);
          },
          onLocalShareChanged: (
            stream,
            audioAvailable,
            active = Boolean(stream),
            nextCaptureMode = "browser",
            nextEncoder,
          ) => {
            if (disposed) return;
            setIsSharing(active);
            setHasSystemAudio(audioAvailable);
            setCaptureMode(active ? nextCaptureMode : null);
            setEncoder(active ? nextEncoder : undefined);
          },
          onConnectionCommitted: (participantId, mode) => {
            if (disposed) return;
            diagnosticLog("viewer", "connection.committed", { participantId, transport: mode });
            setSelectedSharerId(participantId);
            setTransport(mode);
          },
          onError: (message) => {
            diagnosticLog("media", "error", { message }, "error");
            if (!disposed) setMediaError(message);
          },
          onStats: (nextStats) => !disposed && setStats(nextStats),
          onPublisherStats: (nextStats) => !disposed && setPublisherStats(nextStats),
        },
        VIDEO_PRESETS[2]!,
      );
      managerRef.current = manager;

      signaling.onMessage = (message) => {
        if (disposed || !manager) return;
        updateRoomState(message, manager);
        void manager.handleSignal(message).catch((error) => {
          diagnosticLog("media", "signal-handler.failed", errorDetails(error), "error");
          setMediaError(error instanceof Error ? error.message : "媒体信令处理失败");
        });
      };
      try {
        applySnapshot(await signaling.connect());
      } catch (error) {
        if (disposed) return;
        diagnosticLog("room", "connect.failed", errorDetails(error), "error");
        setConnectionState("failed");
        setMediaError(error instanceof Error ? error.message : "无法连接房间");
      }
    };

    const updateRoomState = (message: ServerSignalMessage, mediaManager: P2PMediaManager) => {
      switch (message.type) {
        case "auth.ok":
          applySnapshot(message.snapshot);
          return;
        case "participant.joined":
          setParticipants((current) => [
            ...current.filter((participant) => participant.id !== message.participant.id),
            message.participant,
          ]);
          return;
        case "participant.left":
          setParticipants((current) =>
            current.filter((participant) => participant.id !== message.participantId),
          );
          setShares((current) =>
            current.filter((share) => share.participantId !== message.participantId),
          );
          mediaManager.handleShareStopped(message.participantId);
          return;
        case "share.updated":
          setShares((current) => [
            ...current.filter((share) => share.participantId !== message.share.participantId),
            message.share,
          ]);
          if (message.share.participantId === session.participant.id) {
            mediaManager.setViewerCount(message.share.viewerCount);
          }
          return;
        case "share.stopped":
          setShares((current) =>
            current.filter((share) => share.participantId !== message.participantId),
          );
          mediaManager.handleShareStopped(message.participantId);
          return;
        case "room.closed":
          setConnectionState("disconnected");
          setMediaError(message.reason);
          return;
        default:
          return;
      }
    };

    void initialize();
    return () => {
      disposed = true;
      diagnosticLog("room", "session.disposed", { participantId: session.participant.id });
      signaling.close();
      signalingRef.current = undefined;
      managerRef.current = undefined;
      void manager?.close();
    };
  }, [applySnapshot, session]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = selectedStream;
    diagnosticLog("viewer", "video.src-object", {
      attached: Boolean(selectedStream),
      tracks: selectedStream?.getTracks().map((track) => ({
        kind: track.kind,
        id: track.id,
        muted: track.muted,
        readyState: track.readyState,
      })),
    });
    if (selectedStream) {
      void video.play()
        .then(() => diagnosticLog("viewer", "video.play.resolved"))
        .catch((error) => diagnosticLog("viewer", "video.play.rejected", errorDetails(error), "error"));
    }
    const timer = selectedStream
      ? setInterval(() => {
          diagnosticLog("viewer", "video.element-state", {
            readyState: video.readyState,
            networkState: video.networkState,
            paused: video.paused,
            ended: video.ended,
            currentTime: video.currentTime,
            videoWidth: video.videoWidth,
            videoHeight: video.videoHeight,
          });
        }, 15_000)
      : undefined;
    return () => {
      if (timer) clearInterval(timer);
      if (video.srcObject === selectedStream) video.srcObject = null;
    };
  }, [selectedStream]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const eventNames = [
      "loadedmetadata",
      "loadeddata",
      "canplay",
      "playing",
      "waiting",
      "stalled",
      "suspend",
      "emptied",
      "ended",
      "error",
      "resize",
    ] as const;
    const listeners = eventNames.map((eventName) => {
      const listener = () => diagnosticLog(
        "viewer",
        `video.${eventName}`,
        {
          readyState: video.readyState,
          networkState: video.networkState,
          paused: video.paused,
          currentTime: video.currentTime,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          errorCode: video.error?.code,
          errorMessage: video.error?.message,
        },
        eventName === "error" || eventName === "stalled" ? "warn" : "info",
      );
      video.addEventListener(eventName, listener);
      return { eventName, listener };
    });
    return () => {
      for (const { eventName, listener } of listeners) {
        video.removeEventListener(eventName, listener);
      }
    };
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const isLocal = displayedSharerId === session.participant.id;
    audio.srcObject = isLocal ? null : selectedStream;
    if (audio.srcObject) {
      audio.play().catch((error) => {
        diagnosticLog("viewer", "audio.play.rejected", errorDetails(error), "warn");
        setAudioBlocked(true);
      });
    }
    return () => {
      if (audio.srcObject === selectedStream) audio.srcObject = null;
    };
  }, [displayedSharerId, selectedStream, session.participant.id]);

  const sharers = useMemo<RoomSharer[]>(
    () =>
      shares.map((share) => ({
        id: share.participantId,
        name: share.displayName,
        isLocal: share.participantId === session.participant.id,
        preset: share.preset,
        hasSystemAudio: share.hasSystemAudio,
        viewerCount: share.viewerCount,
      })),
    [session.participant.id, shares],
  );

  const selectSharer = useCallback(
    (participantId: string) => {
      const share = shares.find((candidate) => candidate.participantId === participantId);
      if (!share) return;
      setSelectedSharerId(participantId);
      setMediaError("");
      managerRef.current?.selectShare(share);
    },
    [shares],
  );

  const startSharing = useCallback(async (sourceId: string, preset: VideoPreset) => {
    const manager = managerRef.current;
    if (!manager) throw new Error("房间连接尚未建立");
    await manager.startSharing(sourceId, preset);
  }, []);

  const updateSharePreset = useCallback(async (preset: VideoPreset) => {
    const manager = managerRef.current;
    if (!manager) return;
    await manager.updatePreset(preset);
  }, []);

  const stopSharing = useCallback(async () => {
    await managerRef.current?.stopSharing();
  }, []);

  const retryConnection = useCallback(() => signalingRef.current?.reconnect(), []);
  const resumeAudio = useCallback(async () => {
    await audioRef.current?.play();
    setAudioBlocked(false);
  }, []);

  return {
    participants,
    sharers,
    selectedSharer: sharers.find((sharer) => sharer.id === selectedSharerId),
    selectedSharerId,
    displayedSharerId,
    selectSharer,
    startSharing,
    updateSharePreset,
    stopSharing,
    isSharing,
    hasSystemAudio,
    connectionState,
    mediaError,
    retryConnection,
    audioBlocked,
    resumeAudio,
    participantCount: participants.length,
    transport,
    stats,
    publisherStats,
    captureMode,
    encoder,
    videoRef,
    audioRef,
  };
}
