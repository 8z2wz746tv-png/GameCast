import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  listCaptureSources: () => ipcRenderer.invoke("capture:list-sources"),
  selectCaptureSource: (sourceId: string) =>
    ipcRenderer.invoke("capture:select-source", sourceId),
  listNetworkInterfaces: () => ipcRenderer.invoke("host:list-networks"),
  getHostSettings: () => ipcRenderer.invoke("host:get-settings"),
  saveHostSettings: (settings: unknown) => ipcRenderer.invoke("host:save-settings", settings),
  startHostServer: (address: string) => ipcRenderer.invoke("host:start", address),
  stopHostServer: () => ipcRenderer.invoke("host:stop"),
  startNativeMedia: (request: unknown) => ipcRenderer.invoke("native-media:start", request),
  updateNativeMediaPreset: (preset: unknown, maxBitrate: number) =>
    ipcRenderer.invoke("native-media:update-preset", preset, maxBitrate),
  createNativeMediaOffer: (connectionId: string) =>
    ipcRenderer.invoke("native-media:create-offer", connectionId),
  setNativeMediaAnswer: (connectionId: string, answer: unknown) =>
    ipcRenderer.invoke("native-media:set-answer", connectionId, answer),
  addNativeMediaIceCandidate: (connectionId: string, candidate: unknown) =>
    ipcRenderer.invoke("native-media:add-ice", connectionId, candidate),
  closeNativeMediaPeer: (connectionId: string) =>
    ipcRenderer.invoke("native-media:close-peer", connectionId),
  stopNativeMedia: () => ipcRenderer.invoke("native-media:stop"),
  logDiagnostic: (entry: unknown) => ipcRenderer.send("diagnostics:log", entry),
  exportDiagnostics: () => ipcRenderer.invoke("diagnostics:export"),
  onNativeMediaEvent: (callback: (event: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("native-media:event", listener);
    return () => ipcRenderer.removeListener("native-media:event", listener);
  },
});
