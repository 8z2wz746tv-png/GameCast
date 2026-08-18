/// <reference types="vite/client" />

import type {
  IceCandidateData,
  IceServerConfig,
  SessionDescriptionData,
  VideoPreset,
} from "@gamecast/contracts";

export type CaptureSource = {
  id: string;
  name: string;
  thumbnail: string;
  appIcon?: string;
};

export type NetworkInterfaceCandidate = {
  id: string;
  name: string;
  address: string;
  kind: "tailscale" | "zerotier" | "wireguard" | "other";
  recommended: boolean;
};

export type HostSettingsStatus = {
  turnUrls: string;
  livekitServerUrl: string;
  hasTurnSecret: boolean;
  hasLivekitCredentials: boolean;
  encryptionAvailable: boolean;
};

export type HostSettingsInput = {
  turnUrls: string;
  turnSharedSecret?: string;
  livekitServerUrl: string;
  livekitApiKey?: string;
  livekitApiSecret?: string;
  clearTurnSecret?: boolean;
  clearLivekitCredentials?: boolean;
};

export type HostedServerInfo = {
  serverUrl: string;
  address: string;
  port: number;
  networkName: string;
  networkKind: NetworkInterfaceCandidate["kind"];
  turnConfigured: boolean;
  sfuConfigured: boolean;
};

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
  | { type: "ice"; connectionId: string; candidate: IceCandidateData | null }
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

export type DiagnosticLogEntry = {
  level?: "debug" | "info" | "warn" | "error";
  scope: string;
  event: string;
  data?: unknown;
};

declare global {
  interface ImportMetaEnv {
    readonly VITE_CONTROL_SERVER_URL?: string;
    readonly VITE_PUBLIC_CONTROL_SERVER_URL?: string;
  }

  interface Window {
    electronAPI?: {
      listCaptureSources: () => Promise<CaptureSource[]>;
      selectCaptureSource: (sourceId: string) => Promise<void>;
      listNetworkInterfaces: () => Promise<NetworkInterfaceCandidate[]>;
      getHostSettings: () => Promise<HostSettingsStatus>;
      saveHostSettings: (settings: HostSettingsInput) => Promise<HostSettingsStatus>;
      startHostServer: (address: string) => Promise<HostedServerInfo>;
      stopHostServer: () => Promise<void>;
      startNativeMedia: (request: NativeMediaStartRequest) => Promise<NativeMediaStartResult>;
      updateNativeMediaPreset: (
        preset: VideoPreset,
        maxBitrate: number,
      ) => Promise<NativeMediaStartResult>;
      createNativeMediaOffer: (connectionId: string) => Promise<SessionDescriptionData>;
      setNativeMediaAnswer: (
        connectionId: string,
        answer: SessionDescriptionData,
      ) => Promise<void>;
      addNativeMediaIceCandidate: (
        connectionId: string,
        candidate: IceCandidateData | null,
      ) => Promise<void>;
      closeNativeMediaPeer: (connectionId: string) => Promise<void>;
      stopNativeMedia: () => Promise<void>;
      logDiagnostic: (entry: DiagnosticLogEntry) => void;
      exportDiagnostics: () => Promise<{ path: string }>;
      onNativeMediaEvent: (callback: (event: NativeMediaEvent) => void) => () => void;
    };
  }
}
