import type { ServerSignalMessage } from "@gamecast/contracts";

/**
 * Who is currently watching this participant's screen.
 *
 * The server notifies the sharer with `watch.requested` when a viewer starts and `watch.released`
 * when that watch ends (`signal-hub.notifyWatchReleased` sends to both sides), so the sharer's own
 * client can track its audience without any extra protocol.
 */
export type ActiveWatcher = {
  connectionId: string;
  id: string;
  displayName: string;
};

/**
 * Returns the *same* array reference when a message does not affect the audience, so React can bail
 * out of the re-render.
 */
export function updateActiveWatchers(
  watchers: ActiveWatcher[],
  message: ServerSignalMessage,
): ActiveWatcher[] {
  switch (message.type) {
    case "watch.requested":
      return [
        ...watchers.filter((watcher) => watcher.connectionId !== message.connectionId),
        {
          connectionId: message.connectionId,
          id: message.viewer.id,
          displayName: message.viewer.displayName,
        },
      ];
    case "watch.released":
      return watchers.filter((watcher) => watcher.connectionId !== message.connectionId);
    case "participant.left":
      return watchers.filter((watcher) => watcher.id !== message.participantId);
    case "room.closed":
      return watchers.length === 0 ? watchers : [];
    default:
      return watchers;
  }
}

/** Short, non-alarming summary for the sharing banner. */
export function describeWatchers(watchers: readonly ActiveWatcher[]): string {
  if (watchers.length === 0) return "当前没有人在观看";
  const names = watchers.map((watcher) => watcher.displayName);
  if (names.length <= 2) return `${names.join("、")} 正在观看`;
  return `${names[0]} 等 ${names.length} 人正在观看`;
}
