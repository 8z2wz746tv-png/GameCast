/**
 * Decides whether the `VITE_DEV_SERVER_URL` override may be loaded into the main window.
 *
 * That window carries the preload bridge, so whatever origin it loads receives the entire IPC
 * surface — screen capture, VPN control, and the handlers that end in `spawn`. Only an unpackaged
 * build may point it at a dev server, and only over loopback http.
 *
 * Kept free of Electron imports so it stays unit-testable outside an Electron runtime.
 */
export function resolveDevServerUrl(
  raw: string | undefined,
  isPackaged: boolean,
): string | undefined {
  if (isPackaged) return undefined;
  const value = raw?.trim();
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const loopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "http:" || !loopback) return undefined;
  return url.toString();
}
