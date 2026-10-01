export type ParticipantRole = "host" | "member";
export type MediaMode = "hybrid";
export type MediaTransport = "p2p" | "turn" | "sfu";
export type NetworkMode = "direct" | "easytier";

/** Public room networking details. Secrets are intentionally not part of a session. */
export type RoomNetworkInfo = {
  mode: NetworkMode;
  virtualIp?: string;
  networkName?: string;
  peerAddresses?: string[];
};

export type ParticipantSummary = {
  id: string;
  displayName: string;
  role: ParticipantRole;
};

export type RoomLimits = {
  maxParticipants: number;
  maxSharers: number;
  maxViewersPerShare: number;
};

export type RoomSummary = {
  id: string;
  code: string;
  title: string;
  createdAt: string;
  mediaMode: MediaMode;
  limits: RoomLimits;
  participantCount: number;
  activeSharerCount: number;
  sfuAvailable: boolean;
};

export type IceServerConfig = {
  urls: string[];
  username?: string;
  credential?: string;
};

export type SignalingSession = {
  path: string;
  reconnectGraceSeconds: number;
};

export type P2PSession = {
  iceServers: IceServerConfig[];
  connectionTimeoutSeconds: number;
  candidatePolicy: "all" | "selected";
};

export type ControlServerHealth = {
  status: "ok";
  deploymentMode: "embedded" | "internet";
  p2p: true;
  stunAvailable: boolean;
  turnAvailable: boolean;
  sfuAvailable: boolean;
  sfuViewerThreshold: number;
};

export type NetworkPreflightSession = {
  p2p: P2PSession;
  sfuAvailable: boolean;
  issuedAt: string;
};

export type SfuSession = {
  serverUrl: string;
  token: string;
};

export type RoomSession = {
  room: RoomSummary;
  participant: ParticipantSummary;
  sessionToken: string;
  signaling: SignalingSession;
  p2p: P2PSession;
  sfu?: SfuSession;
  network?: RoomNetworkInfo;
};

export type CreateRoomRequest = {
  title: string;
  displayName: string;
  password?: string;
  mediaMode: MediaMode;
  limits: RoomLimits;
};

export type JoinRoomRequest = {
  displayName: string;
  password?: string;
};

export type ApiError = {
  error: string;
  message: string;
};

export type VideoPresetName = "480p" | "720p" | "1080p" | "1440p";

export type VideoPreset = {
  name: VideoPresetName;
  label: string;
  width: number;
  height: number;
  frameRate: 30 | 60;
};

export type ShareDescriptor = {
  participantId: string;
  displayName: string;
  preset: VideoPresetName;
  hasSystemAudio: boolean;
  viewerCount: number;
};

export type RoomSnapshot = {
  room: RoomSummary;
  participants: ParticipantSummary[];
  shares: ShareDescriptor[];
  activeWatch?: {
    connectionId: string;
    targetParticipantId: string;
    transport: MediaTransport;
  };
};

export type SessionDescriptionData = {
  type: "offer" | "answer";
  sdp: string;
};

export type IceCandidateData = {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
};

export type ClientSignalMessage =
  | { type: "auth"; sessionToken: string }
  | { type: "heartbeat"; sentAt: number }
  | { type: "share.start"; preset: VideoPresetName; hasSystemAudio: boolean }
  | { type: "share.stop" }
  | { type: "watch.request"; connectionId: string; targetParticipantId: string }
  | { type: "watch.commit"; connectionId: string; transport: MediaTransport }
  | { type: "watch.release"; connectionId: string }
  | { type: "rtc.offer"; connectionId: string; targetParticipantId: string; description: SessionDescriptionData }
  | { type: "rtc.answer"; connectionId: string; targetParticipantId: string; description: SessionDescriptionData }
  | { type: "rtc.ice"; connectionId: string; targetParticipantId: string; candidate: IceCandidateData | null }
  | { type: "p2p.failed"; connectionId: string; targetParticipantId: string }
  | { type: "sfu.publisher-ready"; connectionId: string; targetParticipantId: string };

export type ServerSignalMessage =
  | { type: "auth.ok"; snapshot: RoomSnapshot }
  | { type: "heartbeat.ack"; sentAt: number }
  | { type: "participant.joined"; participant: ParticipantSummary; participantCount: number }
  | { type: "participant.left"; participantId: string; participantCount: number }
  | { type: "share.updated"; share: ShareDescriptor }
  | { type: "share.stopped"; participantId: string }
  | { type: "watch.pending"; connectionId: string; targetParticipantId: string; transport: "p2p" | "sfu"; expiresAt: number }
  | { type: "watch.requested"; connectionId: string; viewer: ParticipantSummary }
  | { type: "watch.committed"; connectionId: string; targetParticipantId: string; transport: MediaTransport }
  | { type: "watch.released"; connectionId: string; participantId: string }
  | { type: "watch.rejected"; connectionId: string; reason: string }
  | { type: "rtc.offer"; connectionId: string; participantId: string; description: SessionDescriptionData }
  | { type: "rtc.answer"; connectionId: string; participantId: string; description: SessionDescriptionData }
  | { type: "rtc.ice"; connectionId: string; participantId: string; candidate: IceCandidateData | null }
  | { type: "sfu.publish-requested"; connectionId: string; viewer: ParticipantSummary }
  | { type: "sfu.ready"; connectionId: string; targetParticipantId: string }
  | { type: "sfu.unpublish-requested" }
  | { type: "room.closed"; reason: string }
  | { type: "error"; code: string; message: string; connectionId?: string };
