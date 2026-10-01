import { startControlServer } from "./app.js";
import { appConfig, insecureDefaultSecrets } from "./config.js";

// A server booting with the example LiveKit keys would let anyone mint a token for any room, and
// livekit.yaml enables auto_create. Refuse to start instead of coming up quietly insecure.
const reusedSecrets = insecureDefaultSecrets({
  livekitApiKey: appConfig.livekit?.apiKey,
  livekitApiSecret: appConfig.livekit?.apiSecret,
  allowInsecureDefaults: appConfig.allowInsecureDefaults === true,
});
if (reusedSecrets.length > 0) {
  throw new Error(
    `${reusedSecrets.join("、")} 仍在使用仓库内的示例值，这会让任何人都能签发 LiveKit 令牌。` +
      "请改成独立密钥，或在本地开发时显式设置 ALLOW_INSECURE_DEFAULTS=true。",
  );
}

await startControlServer(appConfig);
