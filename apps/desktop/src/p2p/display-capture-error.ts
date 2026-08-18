import type { VideoPreset } from "@gamecast/contracts";

export type CaptureSourceKind = "screen" | "window";

export function shouldUseNativeScreenCapture(sourceId: string, electronAvailable: boolean): boolean {
  return electronAvailable && /^screen:\d+:/.test(sourceId);
}

function errorName(error: unknown): string {
  if (typeof error !== "object" || error === null || !("name" in error)) return "";
  return String(error.name);
}

export function displayCaptureErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

export function isSystemAudioCaptureFailure(error: unknown): boolean {
  const details = `${errorName(error)} ${displayCaptureErrorMessage(error)}`.toLowerCase();
  return ["audio source", "audio capture", "system audio", "loopback audio", "loopback"].some(
    (fragment) => details.includes(fragment),
  );
}

export function describeDisplayCaptureFailure(
  error: unknown,
  sourceKind: CaptureSourceKind,
  preset: VideoPreset,
): string {
  const name = errorName(error);
  const details = displayCaptureErrorMessage(error);
  const sourceLabel = sourceKind === "screen" ? "屏幕" : "窗口";

  if (name === "NotAllowedError" || name === "AbortError") {
    return `已取消${sourceLabel}共享，或系统没有授予捕获权限`;
  }
  if (name === "NotFoundError") return `找不到所选${sourceLabel}，请重新选择`;
  if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
    return `${preset.label} ${preset.frameRate}fps 在所选${sourceLabel}上不可用`;
  }
  if (name === "NotReadableError") {
    return `无法读取所选${sourceLabel}，它可能已关闭或正被其他程序占用`;
  }
  return `无法启动${sourceLabel}捕获${details ? `：${details}` : ""}`;
}
