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
   - `TURN_URLS`：必须是客户端可访问的公网 IP 或域名，不能填写 `localhost`、`127.0.0.1` 或容器名。
   - `TURN_SHARED_SECRET`：必须与 coturn 的 `static-auth-secret` 相同。
   - `LIVEKIT_WS_URL`：必须是客户端可访问的 `wss://` 地址；控制服务会用对应的 HTTP(S) 地址检查 LiveKit。
   - `LIVEKIT_API_URL`：可选的内部 LiveKit HTTP 地址；公网 WSS 使用反向代理子路径时应设置它。
   - `SFU_VIEWER_THRESHOLD=2`：第一名观看者 P2P，第二名开始使用 SFU。

4. 启动控制服务、LiveKit 和 coturn：

   ```powershell
   docker compose -f infra/docker-compose.yml up -d
   ```

   低内存服务器可以先在开发机执行 `npm run build -w @gamecast/server`，再使用
   `infra/server-runtime.Dockerfile` 构建仅包含运行时依赖的控制服务镜像。

5. 在反向代理中转发控制 API/WebSocket 到 `8787`，为 LiveKit 配置 WSS 域名。生产环境必须使用独立密钥、HTTPS/WSS 和访问日志。
6. 云防火墙至少放行：

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

## 运维边界

房间和会话当前保存在控制服务内存中，服务重启后房间失效，不支持多实例共享状态。公网长期运行前应增加进程守护、HTTPS 证书自动续期、备份密钥和监控；TURN relay 是主要流量成本来源。
