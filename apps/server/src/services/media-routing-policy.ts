export type InitialMediaRouteInput = {
  sfuAvailable: boolean;
  existingViewerCount: number;
  sfuViewerThreshold: number;
};

export function selectInitialMediaRoute(input: InitialMediaRouteInput): "p2p" | "sfu" {
  if (!input.sfuAvailable) return "p2p";
  const threshold = Math.max(2, input.sfuViewerThreshold);
  return input.existingViewerCount + 1 >= threshold ? "sfu" : "p2p";
}
