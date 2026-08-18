import WebSocket from "ws";
import { RTCPeerConnection } from "werift";

const baseUrl = "https://sunsetshimmer.mindtype.cn/gamecast";
const healthResponse = await fetch(`${baseUrl}/health`);
if (!healthResponse.ok) throw new Error(`Health failed: ${healthResponse.status}`);
const health = await healthResponse.json();

const createResponse = await fetch(`${baseUrl}/api/rooms`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    title: "Deployment smoke test",
    displayName: "Deployment",
    mediaMode: "hybrid",
    limits: { maxParticipants: 2, maxSharers: 1, maxViewersPerShare: 1 },
  }),
});
if (!createResponse.ok) throw new Error(`Create failed: ${createResponse.status}`);
const session = await createResponse.json();

const peer = new RTCPeerConnection({
  iceServers: session.p2p.iceServers,
  iceUseIpv4: true,
  iceUseIpv6: false,
});
peer.createDataChannel("turn-smoke");
const candidateTypes = new Set();
const gatheringComplete = new Promise((resolve) => {
  peer.onIceCandidate.subscribe((candidate) => {
    if (candidate) {
      const type = candidate.candidate.match(/\styp\s(\w+)/)?.[1];
      if (type) candidateTypes.add(type);
    }
    else resolve();
  });
});
await peer.setLocalDescription(await peer.createOffer());
await Promise.race([
  gatheringComplete,
  new Promise((_, reject) => setTimeout(() => reject(new Error("ICE gathering timeout")), 12_000)),
]);
await peer.close();

const signalUrl = new URL(`${baseUrl}/${session.signaling.path.replace(/^\/+/, "")}`);
signalUrl.protocol = "wss:";
const socket = new WebSocket(signalUrl);
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("WebSocket timeout")), 8_000);
  socket.once("open", () => {
    socket.send(JSON.stringify({ type: "auth", sessionToken: session.sessionToken }));
  });
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type !== "auth.ok") return;
    clearTimeout(timeout);
    resolve();
  });
  socket.once("error", reject);
});
socket.close();

await fetch(`${baseUrl}/api/session`, {
  method: "DELETE",
  headers: { Authorization: `Bearer ${session.sessionToken}` },
});

console.log(JSON.stringify({
  health,
  roomCreated: true,
  websocketAuthenticated: true,
  candidatePolicy: session.p2p.candidatePolicy,
  hasSfuSession: Boolean(session.sfu),
  candidateTypes: [...candidateTypes].sort(),
}));
process.exit(0);
