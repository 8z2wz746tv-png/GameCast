export type RoomInvitation = {
  serverUrl: string;
  code: string;
  title?: string;
};

export function formatRoomInvitation(invitation: RoomInvitation): string {
  return [
    "GameCast 房间邀请",
    `服务器：${invitation.serverUrl.trim()}`,
    `口令：${invitation.code.trim().toUpperCase()}`,
    ...(invitation.title?.trim() ? [`房间：${invitation.title.trim()}`] : []),
  ].join("\n");
}

export function parseRoomInvitation(value: string): RoomInvitation | undefined {
  const text = value.trim();
  if (!text) return undefined;

  const labeledServer = text.match(
    /(?:服务器(?:地址)?|地址)\s*[:：]\s*(https?:\/\/[^\s·]+)/i,
  )?.[1];
  const labeledCode = text.match(/(?:房间)?口令\s*[:：]\s*([a-z0-9]{6})/i)?.[1];
  const labeledTitle = text.match(/房间\s*[:：]\s*([^\r\n·]+)/)?.[1]?.trim();
  if (labeledServer && labeledCode) {
    return {
      serverUrl: stripTrailingPunctuation(labeledServer),
      code: labeledCode.toUpperCase(),
      title: labeledTitle,
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
