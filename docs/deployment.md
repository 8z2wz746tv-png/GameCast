# 部署说明

GameCast 有两种部署模式：

- `internet`：公网控制节点负责房间、REST 和 WebSocket 信令；媒体先尝试 WebRTC P2P，失败后使用 TURN。LiveKit 可选，默认第一名观看者走 P2P，第二名及以后走 SFU。
- `embedded`：Windows 房主在客户端内启动控制服务，适合局域网或已经存在的 Tailscale、ZeroTier、WireGuard 网络。

## 公网控制节点

公网模式不要求朋友安装 Tailscale、ZeroTier 或 WireGuard，但必须有一个公网服务器。控制服务只交换连接信息；P2P 成功时屏幕和系统声音不会经过控制服务。

1. 准备一个公网域名和 HTTPS/WSS 证书。控制 API 使用 HTTPS，信令使用同一域名的 WSS。
2. 复制 `.env.example` 为 `.env`，替换所有开发密钥和示例域名。
3. 设置以下关键变量：

   - `DEPLOYMENT_MODE=internet`
   - `STUN_URLS`：可访问的 STUN 地址，多个地址用逗号分隔。
   - `TURN_URLS`：必须是客户端可访问的公网 IP 或域名，不能填写 `localhost`、`127.0.0.1` 或容器名。UDP/TCP TURN 建议同时提供公网 IPv4 字面地址作为 DNS 故障回退；`turns:` 仍使用证书域名。
   - `TURN_SHARED_SECRET`：必须与 coturn 的 `static-auth-secret` 相同。
   - `TURN_EXTERNAL_IP`：填写 `公网IPv4/容器内网IPv4`，例如 `203.0.113.10/172.19.0.3`；容器网段变化时同步更新。`203.0.113.10` 仅为文档示例，请替换为实际地址。
   - `LIVEKIT_WS_URL`：必须是客户端可访问的 `wss://` 地址；控制服务会用对应的 HTTP(S) 地址检查 LiveKit。
   - `LIVEKIT_API_URL`：可选的内部 LiveKit HTTP 地址；公网 WSS 使用反向代理子路径时应设置它。
   - `SFU_VIEWER_THRESHOLD=2`：第一名观看者 P2P，第二名开始使用 SFU。

4. 准备 coturn 的证书文件。由于官方 coturn 容器默认以 `nobody:nogroup` 运行，
   不要直接挂载权限为 `700` 的 Let's Encrypt `live` 目录；复制证书到部署目录并让
   `nogroup` 可读私钥（目录 `750`、证书和私钥 `640`）后，放在 `coturn-certs/`：

   ```bash
   sudo install -d -o root -g nogroup -m 750 coturn-certs
   sudo install -o root -g nogroup -m 640 \
     /etc/letsencrypt/archive/<domain>/fullchain*.pem coturn-certs/fullchain.pem
   sudo install -o root -g nogroup -m 640 \
     /etc/letsencrypt/archive/<domain>/privkey*.pem coturn-certs/privkey.pem
   ```

   证书续期后要重新复制这两个文件并重建 coturn 容器。

5. 启动控制服务、LiveKit 和 coturn：

   ```powershell
   docker compose -f infra/docker-compose.yml up -d
   ```

   低内存服务器可以先在开发机执行 `npm run build -w @gamecast/server`，再使用
   `infra/server-runtime.Dockerfile` 构建仅包含运行时依赖的控制服务镜像。

6. 在反向代理中转发控制 API/WebSocket 到 `8787`，为 LiveKit 配置 WSS 域名。生产环境必须使用独立密钥、HTTPS/WSS 和访问日志。
7. 云防火墙至少放行：

   - 控制 API：`8787/tcp`（生产环境建议只允许反向代理访问）。
   - coturn：`3478/tcp`、`3478/udp`、`5349/tcp`（启用 TURN TLS 时）以及 `49160-49200/udp` relay 端口范围。
   - LiveKit：`7880/tcp`、`7881/tcp` 和配置的 UDP 媒体端口范围。

### 桌面端公网地址

构建桌面端时可以通过 `VITE_PUBLIC_CONTROL_SERVER_URL` 设置默认公网控制节点：

```powershell
$env:VITE_PUBLIC_CONTROL_SERVER_URL = "https://control.example.com"
npm run build -w @gamecast/desktop
```

没有设置时，用户仍可在加入页手动填写公网地址。互联网模式会拒绝 `192.168.x.x`、`10.x.x.x`、`172.16/12`、`100.64/10`、`localhost` 等私网控制地址，避免把邀请发成只有房主自己能访问的地址。

## 嵌入式本机房主

嵌入式模式不需要 Docker，但跨互联网不可用。房主选择本机房主后，客户端服务绑定选中的网卡地址，并在 `8787` 到 `8797` 中选择空闲端口。要让异地成员加入，所有成员需要先加入同一虚拟局域网，并在 Windows 防火墙中允许 GameCast 访问对应网络。

房主关闭客户端后房间立即结束，不进行房主迁移。TURN 和 LiveKit 设置仍可在客户端中保存，但互联网模式推荐把它们放在独立公网控制节点上。

### Windows 原生采集运行库

Windows 安装包自带经过 SHA-256 校验的 BtbN FFmpeg x64 GPL 构建（`N-126313-g1ae4048218`）。
该构建包含 `gfxcapture`（Windows Graphics Capture）和 `ddagrab`，客户端会优先使用前者，
并在不可用时回退后者；FFmpeg 许可证随安装包放在 `resources/native/ffmpeg.exe.LICENSE`。

### 内置 EasyTier 组网（可选）

如果朋友不在同一个 Tailscale、ZeroTier 或 WireGuard 网络，可以在加入页选择“内置 EasyTier”。GameCast 只负责启动和监控本机的 `easytier-core.exe`，不自动安装驱动、不修改防火墙，也不会执行第三方安装脚本。

1. 从 EasyTier 发布页取得与 Windows x64 匹配的 `easytier-core.exe`，放到安装目录的 `resources/native/easytier-core.exe`，或在页面中填写外部路径。
2. 房主填写网络名称、网络密钥和可选节点地址，创建房间后使用“复制邀请”。网络密钥会包含在邀请文本中，只有发送给可信朋友。
3. 朋友粘贴完整邀请。客户端会在连接控制服务前启动同名 EasyTier 网络，检测到虚拟网卡后再访问房主地址。
4. 如果 EasyTier 未安装、驱动未就绪或启动超时，客户端会明确提示原因；不会伪装成已组网，也不会影响使用公网控制节点、TURN 或 SFU 的原有模式。

EasyTier 进程仅由启动它的 GameCast 实例停止，不会执行全局 `taskkill`。单文件诊断日志只记录状态、接口名称和最近输出，不记录网络密钥。

## 运维边界

房间和会话当前保存在控制服务内存中，服务重启后房间失效，不支持多实例共享状态。公网长期运行前应增加进程守护、HTTPS 证书自动续期、备份密钥和监控；TURN relay 是主要流量成本来源。
# Windows 代码签名

GameCast 的 Windows 打包已经启用 electron-builder 标准签名流程。正式发布时在构建机配置 `CSC_LINK`（PFX 文件路径或 Base64 内容）和 `CSC_KEY_PASSWORD` 后执行 `npm run package:win`。没有可信代码签名证书时仍可生成测试安装包，但 Windows 会继续显示“未知发布者”；自签名证书不能消除朋友电脑上的该提示。
