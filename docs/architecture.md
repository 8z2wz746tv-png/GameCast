# 架构说明

## 控制面与媒体面

GameCast 将房间控制和媒体传输分开：

```text
Electron / public control node
  |-- REST: create, join, health
  |-- WebSocket: presence, watch, SDP, ICE
  |
  +---- WebRTC P2P (preferred) ---- Sharer
  |       |
  |       +---- TURN relay (ICE fallback)
  |
  +---- LiveKit SFU (optional, audience fan-out)
```

共享者开始共享时只广播元数据；无人观看时不创建媒体连接。每名观看者只保留一路 active watch，切换时允许一路短暂的 pending 预连接，收到首帧后再提交新连接并释放旧连接。

## 混合路由策略

服务端在 `watch.pending` 中明确选择传输路线，客户端不能把 SFU 关系伪装成 P2P 提交：

- 没有可用 LiveKit：所有观看关系使用 P2P，P2P 失败时提示检查网络或配置 TURN。
- LiveKit 可用：第一名观看者使用 P2P；第二名及以后使用 SFU。默认阈值为 2，可由 `SFU_VIEWER_THRESHOLD` 调整到 2～7。
- P2P 失败后，当前观看关系切换到 SFU，并在切换共享者前保持该路线，避免反复跳转。
- 共享者只在收到第一条 SFU 发布请求时发布现有屏幕轨道；最后一名 SFU 观看者离开后取消发布。

## ICE 候选策略

公网模式允许普通 host、srflx 和 relay candidate，配合 STUN/TURN 完成跨运营商连接；嵌入式模式默认只转发选中的虚拟网卡 host candidate。两种模式都不会自动修改 Windows 防火墙。

`P2PSession.candidatePolicy` 由控制服务下发：`all` 表示互联网模式，`selected` 表示嵌入式模式。服务端只转发已建立观看关系对应的 SDP/ICE，并验证发送者、目标参与者和连接 ID。

## 可选虚拟网络适配器

桌面端提供统一的网络适配器边界。默认 `direct` 模式继续使用已有的 Tailscale、ZeroTier、WireGuard 或普通网卡；启用 `easytier` 时，Electron 主进程按房间邀请启动受控的 `easytier-core.exe`，等待虚拟网卡出现后将该地址用于嵌入式房主服务和 WebRTC host candidate 过滤。适配器启动失败只影响这次组网，不会改变公网控制节点、TURN 或 SFU 回退策略。

## 质量与资源

- 1 名观看者：使用共享者上限，1080p60 每路最高 12 Mbps。
- 2 名观看者：1080p60 每路最高 8 Mbps；3 名观看者每路最高 6 Mbps。
- 4～5 名观看者：最高 720p60，每路 3.5 Mbps。
- 6～7 名观看者：最高 720p60，每路 2.5 Mbps。
- 连续统计到带宽不足或丢包时降低单连接码率，连续健康后逐级恢复；不超过用户选择的上限。
- 原生视频编码一次，编码后的 RTP 复用到各 P2P PeerConnection；SFU 发布按需启用。
- 新版媒体运行库优先使用 Windows Graphics Capture，在 D3D11 内缩放并直接交给同适配器硬件编码器。混合显卡设备会先尝试 Intel QSV VPP，最后才使用显存回读兼容路径。0.3.5 发布包内置带 `gfxcapture` 的 FFmpeg x64 构建，并在不可用时自动回退 `ddagrab`；也可通过 `GAMECAST_FFMPEG_PATH` 注入其他经过验证的运行库。
- Chromium 只负责系统声音桥接和 SFU 兼容轨道；普通 P2P 共享时辅助画面保持 320×180、5fps，本地预览不会将它提升到全画质。
- 无人观看时原生编码器在启动验证后自动停止，第一名观看者请求画面时恢复，最后一名观看者离开后再次停止。

## 安全与生命周期

- WebSocket 连接建立后限时使用房间会话令牌认证，同时使用应用心跳和协议层 `ping/pong` 保活；最小化或后台节流不会误清理在线会话。
- 信令最大消息 64 KiB，带来源、目标和频率限制。
- TURN 共享密钥与 LiveKit API 密钥由 Electron `safeStorage` 加密保存，不进入渲染进程日志。
- 房主离开会关闭房间；公网控制节点本身不持有媒体内容。
