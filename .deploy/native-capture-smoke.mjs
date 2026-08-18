import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, desktopCapturer } from "electron";
import { NativeMediaService } from "../apps/desktop/dist-electron/native-media.js";

const outputIndex = Number(process.env.GAMECAST_CAPTURE_OUTPUT ?? 0);
const durationSeconds = Number(process.env.GAMECAST_CAPTURE_SECONDS ?? 12);
const preset = {
  name: "1080p",
  label: "1080p",
  width: 1920,
  height: 1080,
  frameRate: 60,
};
const publisherEvents = [];
const errors = [];
const resultPath = join(tmpdir(), "gamecast-native-capture-smoke.json");
const writeResult = (result) => writeFileSync(resultPath, JSON.stringify(result, null, 2), "utf8");
const service = new NativeMediaService((event) => {
  if (event.type === "publisher-stats") publisherEvents.push(event);
  if (event.type === "error") errors.push(event.message);
});
const safetyTimer = setTimeout(() => {
  writeResult({ status: "failed", stage: "timeout", message: "native smoke test exceeded 60 seconds" });
  app.exit(2);
}, 60_000);

writeResult({ status: "running", stage: "waiting-for-electron" });
void app.whenReady().then(runSmokeTest).catch((error) => {
  writeResult({
    status: "failed",
    stage: "electron-ready",
    message: error instanceof Error ? error.message : String(error),
  });
  app.exit(1);
});

async function runSmokeTest() {
let failed = false;
try {
  writeResult({ status: "running", stage: "enumerating-screens" });
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 320, height: 180 },
  });
  const source = sources[outputIndex];
  assert.ok(source, `screen output ${outputIndex} was not found (${sources.length} available)`);

  writeResult({ status: "running", stage: "calibrating-screens", screenCount: sources.length });
  const calibration = await service.calibrateOutputIndexes(sources.map((candidate) => {
    const size = candidate.thumbnail.getSize();
    return {
      sourceId: candidate.id,
      width: size.width,
      height: size.height,
      pixels: candidate.thumbnail.toBitmap(),
    };
  }));
  assert.equal(calibration.reliable, true, `screen calibration was ambiguous: ${JSON.stringify(calibration)}`);
  const nativeOutputIndex = calibration.matches.find(
    (candidate) => candidate.sourceId === source.id,
  )?.outputIndex;
  assert.notEqual(nativeOutputIndex, undefined, "selected screen has no calibrated DXGI output");

  writeResult({ status: "running", stage: "starting-native-media", screenCount: sources.length });
  const started = await service.start({
    sourceId: source.id,
    outputIndex: nativeOutputIndex,
    preset,
    maxBitrate: 12_000_000,
    iceServers: [],
    allowedHostAddresses: [],
  });
  writeResult({ status: "running", stage: "sampling", encoder: started.encoder });
  await delay(durationSeconds * 1_000);

  const frameSamples = publisherEvents
    .map((event) => event.framesPerSecond)
    .filter((value) => Number.isFinite(value) && value > 0);
  const actualFps = frameSamples.at(-1) ?? 0;
  const rtpSample = publisherEvents.findLast((event) => (event.rtpPackets ?? 0) > 0);
  assert.ok(actualFps >= 55, `native capture only reached ${actualFps} fps`);
  assert.ok((rtpSample?.rtpPackets ?? 0) > 0, "native capture produced no RTP packets");
  assert.equal(errors.length, 0, errors.join("; "));

  const result = {
    status: "passed",
    screenCount: sources.length,
    selectedScreen: source.name,
    outputIndex: nativeOutputIndex,
    calibration,
    encoder: started.encoder,
    target: `${started.width}x${started.height}@${started.frameRate}`,
    bitrateKbps: started.bitrateKbps,
    actualFps,
    rtpPackets: rtpSample.rtpPackets,
    durationSeconds,
  };
  writeResult(result);
  console.log(JSON.stringify(result));
} catch (error) {
  writeResult({
    status: "failed",
    stage: "exception",
    message: error instanceof Error ? error.message : String(error),
  });
  failed = true;
} finally {
  clearTimeout(safetyTimer);
  await service.stop().catch(() => undefined);
  if (failed) app.exit(1);
  else app.quit();
}
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
