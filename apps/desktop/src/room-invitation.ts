export type RoomInvitation = {
  serverUrl: string;
  code: string;
  title?: string;
  network?: {
    mode: "easytier";
    name: string;
    secret: string;
    peers?: string[];
  };
};

export function formatRoomInvitation(invitation: RoomInvitation): string {
  const url = new URL("gamecast://join");
  url.searchParams.set("server", invitation.serverUrl.trim());
  url.searchParams.set("code", invitation.code.trim().toUpperCase());
  if (invitation.title?.trim()) url.searchParams.set("title", invitation.title.trim());
  if (invitation.network) {
    url.searchParams.set("network", invitation.network.mode);
    url.searchParams.set("networkName", invitation.network.name.trim());
    url.searchParams.set("networkSecret", invitation.network.secret.trim());
    for (const peer of invitation.network.peers ?? []) url.searchParams.append("peer", peer);
  }
  const roomName = invitation.title?.trim() ? `“${invitation.title.trim()}”` : "";
  return `加入我的 GameCast 房间${roomName}：${url.toString()}`;
}

export function parseRoomInvitation(value: string): RoomInvitation | undefined {
  const text = value.trim();
  if (!text) return undefined;

  const deepLink = text.match(/gamecast:\/\/join\?[^\s]+/i)?.[0];
  if (deepLink) {
    try {
      const url = new URL(stripTrailingPunctuation(deepLink));
      const serverUrl = url.searchParams.get("server")?.trim();
      const code = url.searchParams.get("code")?.trim();
      const title = url.searchParams.get("title")?.trim();
      const networkMode = url.searchParams.get("network");
      const networkName = url.searchParams.get("networkName")?.trim();
      const networkSecret = url.searchParams.get("networkSecret")?.trim();
      const peers = url.searchParams.getAll("peer").map((peer) => peer.trim()).filter(Boolean);
      if (url.protocol === "gamecast:" && url.hostname === "join" && serverUrl && /^[a-z0-9]{6}$/i.test(code ?? "")) {
        return {
          serverUrl,
          code: code!.toUpperCase(),
          ...(title ? { title } : {}),
          ...(networkMode === "easytier" && networkName && networkSecret
            ? { network: { mode: "easytier" as const, name: networkName, secret: networkSecret, peers } }
            : {}),
        };
      }
    } catch {
      return undefined;
    }
  }

  const labeledServer = text.match(
    /(?:服务器(?:地址)?|地址)\s*[:：]\s*(https?:\/\/[^\s·]+)/i,
  )?.[1];
  const labeledCode = text.match(/(?:房间)?口令\s*[:：]\s*([a-z0-9]{6})/i)?.[1];
  const labeledTitle = text.match(/房间\s*[:：]\s*([^\r\n·]+)/)?.[1]?.trim();
  const networkMode = text.match(/组网\s*[:：]\s*(easytier)/i)?.[1];
  const networkName = text.match(/网络名称\s*[:：]\s*([^\r\n·]+)/i)?.[1]?.trim();
  const networkSecret = text.match(/网络密钥\s*[:：]\s*([^\r\n·]+)/i)?.[1]?.trim();
  const networkPeers = text
    .match(/网络节点\s*[:：]\s*([^\r\n·]+)/i)?.[1]
    ?.split(",")
    .map((peer) => peer.trim())
    .filter(Boolean);
  if (labeledServer && labeledCode) {
    return {
      serverUrl: stripTrailingPunctuation(labeledServer),
      code: labeledCode.toUpperCase(),
      ...(labeledTitle ? { title: labeledTitle } : {}),
      ...(networkMode && networkName && networkSecret
        ? { network: { mode: "easytier" as const, name: networkName, secret: networkSecret, peers: networkPeers } }
        : {}),
    };
  }

  const legacyParts = text.split("·").map((part) => part.trim()).filter(Boolean);
  const legacyServer = legacyParts.find((part) => /^https?:\/\//i.test(part));
  const legacyCode = legacyParts.find((part) => /^[a-z0-9]{6}$/i.test(part));
  if (legacyServer && legacyCode) {
    const title = legacyParts.find((part) => part !== legacyServer && part !== legacyCode);
    return {
      serverUrl: stripTrailingPunctuation(legacyServer),
      code: legacyCode.toUpperCase(),
      title,
    };
  }

  return undefined;
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[，,;；。]+$/, "");
}
