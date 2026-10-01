# GameCast

GameCast 是面向小型游戏团体的开源 Windows 屏幕共享工具。房间最多 8 人、最多 4 名共享者；观看者只连接当前选择的一路画面。

默认媒体路径：

```text
WebRTC P2P 直连 -> 可选 TURN -> 可选 LiveKit SFU
```

公网模式下，用户只需安装 GameCast。公网控制节点负责房间、REST 和 WebSocket 信令；P2P 成功时屏幕与系统声音不经过控制节点。第一名观看者优先 P2P，第二名及以后在 LiveKit 可用时使用 SFU，减少共享者重复上传。项目也保留嵌入式本机房主模式，适合局域网或已有虚拟局域网的团体。

嵌入式房主还可以选择内置 EasyTier 适配器，让不在同一局域网的朋友通过一个轻量虚拟网络加入。Windows 安装包包含经过版本和 SHA-256 记录的 EasyTier x64 核心及所需驱动；GameCast 只管理自己启动的进程，默认仍可使用公网控制节点、TURN 或 LiveKit。

屏幕共享优先使用 Windows Graphics Capture 输出的 D3D11 显存帧，并在 GPU 内缩放后交给 NVENC、Quick Sync 或 AMF。运行库不支持 WGC 时，混合显卡笔记本会优先尝试 Intel QSV VPP，再回退 Desktop Duplication 兼容路径；原生路径只对“整个屏幕”生效，失败时自动回退 Chromium。系统声音通过 Electron loopback 捕获并桥接为 Opus，辅助视频固定为低分辨率、低帧率。0.3.5 发布包内置带 `gfxcapture` 的 FFmpeg x64 构建，并保留 `ddagrab` 兼容回退；部署者仍可通过 `GAMECAST_FFMPEG_PATH` 指向其他经过验证的 FFmpeg。

## 目录

- `apps/desktop`：Electron + React Windows 客户端，包含嵌入式房主入口
- `apps/server`：可独立运行或嵌入 Electron 的控制与 WebSocket 信令服务
- `packages/contracts`：REST、房间和信令 TypeScript 契约
- `infra`：可选 LiveKit SFU 与 coturn 配置
- `docs`：架构、部署和异地测试说明

## 开发

要求 Node.js 22 和 npm 10：

```powershell
npm install
npm run dev
```

不配置 `VITE_PUBLIC_CONTROL_SERVER_URL` 时，客户端可以在加入页手动填写公网控制节点。构建时设置该变量可提供默认地址：

```powershell
$env:VITE_PUBLIC_CONTROL_SERVER_URL = "https://control.example.com"
npm run build
```

## 部署公网控制节点

```powershell
Copy-Item .env.example .env
# 编辑 .env：替换域名、TURN/LiveKit 地址和所有开发密钥
docker compose -f infra/docker-compose.yml up -d
```

生产环境必须使用 HTTPS/WSS、独立密钥、TURN TLS（如需要）和云防火墙规则。详细端口、反向代理和运维边界见 [`docs/deployment.md`](docs/deployment.md)。

### 当前公网节点

仓库不内置任何生产密钥。当前版本可以在加入页手动填写控制节点；构建时也可以通过
`VITE_PUBLIC_CONTROL_SERVER_URL` 注入默认地址。部署自己的节点时，请使用自己的域名、证书和
TURN/LiveKit 密钥，不要复制测试环境的 `.env`。

## 测试与构建

```powershell
npm test
npm run typecheck
npm run lint
npm run build
npm run smoke:public
npm run smoke:native
npm run package:win
```

`smoke:public` 会通过已配置的公网节点建立双客户端 P2P 并持续发送 RTP；`smoke:native` 会在本机第一块屏幕上验证 WGC/Desktop Duplication、硬件 H.264 和实际帧率。

发布 EXE 不提交到 Git 仓库；请通过 GitHub Releases 或其他制品存储分发。当前安装包没有商业代码签名证书，Windows 可能显示“未知发布者”。异地朋友测试前请阅读 [`docs/friends-test-checklist.md`](docs/friends-test-checklist.md)。

## 安全边界

- 不要提交 `.env`、TURN 共享密钥、LiveKit 密钥、SSH 私钥或诊断日志。
- 生产部署应使用独立的密钥和最小化的云防火墙规则。
- 房间状态当前保存在控制节点内存中，服务重启后房间会失效。
