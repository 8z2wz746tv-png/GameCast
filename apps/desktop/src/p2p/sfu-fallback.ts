import type { SfuSession, VideoPreset } from "@gamecast/contracts";
import type {
  RemoteParticipant,
  RemoteTrackPublication,
  Room,
} from "livekit-client";
import { diagnosticLog, errorDetails } from "../diagnostics";

type StreamWaiter = {
  targetParticipantId: string;
  stream: MediaStream;
  resolve: (stream: MediaStream) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  resolved: boolean;
};

export class SfuFallback {
  private room: Room | undefined;
  private connecting: Promise<Room> | undefined;
  private sdk: typeof import("livekit-client") | undefined;
  private sdkPromise: Promise<typeof import("livekit-client")> | undefined;
  private publishedStream: MediaStream | undefined;
  private publishedSignature: string | undefined;
  private publicationOperation: Promise<void> = Promise.resolve();
  private subscribedTarget: string | undefined;
  private subscription: StreamWaiter | undefined;

  constructor(private readonly session: SfuSession | undefined) {}

  get available(): boolean {
    return Boolean(this.session);
  }

  publish(stream: MediaStream, preset: VideoPreset, maxBitrate: number): Promise<void> {
    return this.enqueuePublication(() => this.publishExclusive(stream, preset, maxBitrate));
  }

  unpublish(): Promise<void> {
    return this.enqueuePublication(() => this.unpublishExclusive());
  }

  private async publishExclusive(
    stream: MediaStream,
    preset: VideoPreset,
    maxBitrate: number,
  ): Promise<void> {
    const room = await this.ensureConnected();
    const sdk = await this.loadSdk();
    const signature = `${stream.id}:${preset.width}x${preset.height}@${preset.frameRate}:${maxBitrate}`;
    if (this.publishedStream === stream && this.publishedSignature === signature) return;
    await this.unpublishExclusive();
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) throw new Error("没有可发布的屏幕视频轨道");
    const streamName = `screen-${room.localParticipant.identity}`;
    const publishedTracks: MediaStreamTrack[] = [];
    try {
      await room.localParticipant.publishTrack(videoTrack, {
        source: sdk.Track.Source.ScreenShare,
        stream: streamName,
        videoCodec: "h264",
        simulcast: false,
        screenShareEncoding: {
          maxBitrate,
          maxFramerate: preset.frameRate,
        },
      });
      publishedTracks.push(videoTrack);
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        try {
          await room.localParticipant.publishTrack(audioTrack, {
            source: sdk.Track.Source.ScreenShareAudio,
            stream: streamName,
            forceStereo: true,
          });
          publishedTracks.push(audioTrack);
        } catch (error) {
          diagnosticLog("sfu", "audio.publish-failed", errorDetails(error), "warn");
        }
      }
      this.publishedStream = stream;
      this.publishedSignature = signature;
    } catch (error) {
      for (const track of publishedTracks) {
        await room.localParticipant.unpublishTrack(track, false).catch(() => undefined);
      }
      throw error;
    }
  }

  private async unpublishExclusive(): Promise<void> {
    if (!this.room || !this.publishedStream) return;
    for (const track of this.publishedStream.getTracks()) {
      await this.room.localParticipant.unpublishTrack(track, false).catch(() => undefined);
    }
    this.publishedStream = undefined;
    this.publishedSignature = undefined;
  }

  private enqueuePublication(operation: () => Promise<void>): Promise<void> {
    const queued = this.publicationOperation.catch(() => undefined).then(operation);
    this.publicationOperation = queued.catch(() => undefined);
    return queued;
  }

  async subscribe(targetParticipantId: string): Promise<MediaStream> {
    const room = await this.ensureConnected();
    this.unsubscribe();
    this.subscribedTarget = targetParticipantId;
    const stream = new MediaStream();
    const promise = new Promise<MediaStream>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.subscription?.stream === stream) this.subscription = undefined;
        reject(new Error("等待 SFU 画面超时"));
      }, 10_000);
      this.subscription = {
        targetParticipantId,
        stream,
        resolve,
        reject,
        timer,
        resolved: false,
      };
    });
    const participant = room.remoteParticipants.get(targetParticipantId);
    if (participant) this.subscribeParticipant(participant);
    return promise;
  }

  unsubscribe(): void {
    if (this.subscription) {
      if (this.subscription.timer) clearTimeout(this.subscription.timer);
      if (!this.subscription.resolved) {
        this.subscription.reject(new Error("已切换到其他共享者"));
      }
      // The stream handed to the caller otherwise keeps live remote tracks after we stop watching.
      for (const track of this.subscription.stream.getTracks()) {
        this.subscription.stream.removeTrack(track);
        track.stop();
      }
      this.subscription = undefined;
    }
    if (this.room && this.subscribedTarget) {
      const participant = this.room.remoteParticipants.get(this.subscribedTarget);
      if (participant) {
        for (const publication of participant.trackPublications.values()) {
          (publication as RemoteTrackPublication).setSubscribed(false);
        }
      }
    }
    this.subscribedTarget = undefined;
  }

  async disconnect(): Promise<void> {
    this.unsubscribe();
    await this.unpublish();
    this.room?.disconnect();
    this.room = undefined;
    this.connecting = undefined;
  }

  private async ensureConnected(): Promise<Room> {
    if (!this.session) throw new Error("房主没有配置可用的 SFU");
    if (this.room?.state === "connected") return this.room;
    if (this.connecting) return this.connecting;
    const sdk = await this.loadSdk();
    const room = new sdk.Room({
      adaptiveStream: true,
      dynacast: true,
      stopLocalTrackOnUnpublish: false,
    });
    this.registerEvents(room, sdk);
    this.connecting = room
      .connect(this.session.serverUrl, this.session.token, { autoSubscribe: false })
      .then(() => {
        this.room = room;
        this.connecting = undefined;
        return room;
      })
      .catch((error) => {
        this.connecting = undefined;
        room.disconnect();
        throw error;
      });
    return this.connecting;
  }

  private registerEvents(room: Room, sdk: typeof import("livekit-client")): void {
    room.on(sdk.RoomEvent.ParticipantConnected, (participant) => {
      if (participant.identity === this.subscribedTarget) this.subscribeParticipant(participant);
    });
    room.on(sdk.RoomEvent.TrackPublished, (publication, participant) => {
      if (participant.identity !== this.subscribedTarget) return;
      if (
        publication.source === sdk.Track.Source.ScreenShare ||
        publication.source === sdk.Track.Source.ScreenShareAudio
      ) {
        publication.setSubscribed(true);
      }
    });
    room.on(sdk.RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      const subscription = this.subscription;
      if (!subscription || participant.identity !== subscription.targetParticipantId) return;
      if (!subscription.stream.getTracks().some((candidate) => candidate.id === track.mediaStreamTrack.id)) {
        subscription.stream.addTrack(track.mediaStreamTrack);
      }
      if (track.kind === sdk.Track.Kind.Video && !subscription.resolved) {
        if (subscription.timer) clearTimeout(subscription.timer);
        subscription.timer = undefined;
        subscription.resolved = true;
        subscription.resolve(subscription.stream);
      }
    });
  }

  private subscribeParticipant(participant: RemoteParticipant): void {
    const sdk = this.sdk;
    if (!sdk) return;
    for (const publication of participant.trackPublications.values()) {
      if (
        publication.source === sdk.Track.Source.ScreenShare ||
        publication.source === sdk.Track.Source.ScreenShareAudio
      ) {
        (publication as RemoteTrackPublication).setSubscribed(true);
      }
    }
  }

  private async loadSdk(): Promise<typeof import("livekit-client")> {
    if (this.sdk) return this.sdk;
    this.sdkPromise ??= import("livekit-client");
    this.sdk = await this.sdkPromise;
    return this.sdk;
  }
}
