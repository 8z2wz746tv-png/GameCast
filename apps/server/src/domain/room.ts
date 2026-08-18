import type {
  MediaMode,
  MediaTransport,
  ParticipantRole,
  RoomLimits,
  VideoPresetName,
} from "@gamecast/contracts";

export type Participant = {
  id: string;
  displayName: string;
  role: ParticipantRole;
  joinedAt: Date;
};

export type ShareState = {
  participantId: string;
  preset: VideoPresetName;
  hasSystemAudio: boolean;
  startedAt: Date;
};

export type WatchRelation = {
  connectionId: string;
  viewerId: string;
  targetParticipantId: string;
  state: "pending" | "active";
  transport: MediaTransport;
  createdAt: Date;
  expiresAt?: Date;
};

export type Room = {
  id: string;
  code: string;
  title: string;
  createdAt: Date;
  mediaMode: MediaMode;
  limits: RoomLimits;
  sfuAvailable: boolean;
  passwordDigest?: string;
  participants: Map<string, Participant>;
  shares: Map<string, ShareState>;
  watches: Map<string, WatchRelation>;
};

export type Session = {
  token: string;
  roomId: string;
  participantId: string;
  createdAt: Date;
  expiresAt: Date;
};
