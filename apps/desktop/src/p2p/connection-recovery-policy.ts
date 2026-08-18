export type ConnectionRecoveryContext = {
  failedConnectionId: string;
  targetParticipantId: string;
  pendingConnectionId?: string;
  activeConnectionId?: string;
  displayedConnectionId?: string;
  desiredTargetId?: string;
  cooldownUntil: number;
  now: number;
};

export type ConnectionRecoveryAction = "request-fallback" | "replace-active" | "none";

export type PendingConnectionFailureContext = {
  attempt: number;
  maxAttempts: number;
  connectionId: string;
  pendingConnectionId?: string;
  targetParticipantId: string;
  desiredTargetId?: string;
};

export type PendingConnectionFailureAction = "retry-p2p" | "request-fallback" | "none";

export function getPendingConnectionFailureAction(
  context: PendingConnectionFailureContext,
): PendingConnectionFailureAction {
  if (
    context.pendingConnectionId !== context.connectionId ||
    context.desiredTargetId !== context.targetParticipantId
  ) {
    return "none";
  }
  return context.attempt < context.maxAttempts ? "retry-p2p" : "request-fallback";
}

export function getConnectionRecoveryAction(
  context: ConnectionRecoveryContext,
): ConnectionRecoveryAction {
  if (context.pendingConnectionId === context.failedConnectionId) return "request-fallback";
  if (
    context.activeConnectionId === context.failedConnectionId &&
    context.displayedConnectionId === context.failedConnectionId &&
    !context.pendingConnectionId &&
    context.desiredTargetId === context.targetParticipantId &&
    context.now >= context.cooldownUntil
  ) {
    return "replace-active";
  }
  return "none";
}
