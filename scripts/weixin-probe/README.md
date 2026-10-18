# 微信 iLink 渠道探针 / 复测工具

独立于主应用的零依赖 Node 脚本，用于渠道协议验证与回归复测。读写主应用同一份
`~/.onefleet/data/<uid>/cloud/config/channels.json`（凭据存储），可用
`ORKAS_CHANNELS_FILE` 环境变量覆盖定位。

⚠️ 运行 `listen` / `push-test.mjs` 前**必须先退出 OneFleet 应用**——两者会争抢
`get_updates_buf` 消息游标，并行消费会丢消息。测完把游标写回（脚本自动）再重启应用。

## probe.mjs

```bash
node scripts/weixin-probe/probe.mjs login   # 出二维码 → 扫码 → token 写入 channels.json
node scripts/weixin-probe/probe.mjs test    # 凭据探活（不消费消息）
node scripts/weixin-probe/probe.mjs listen  # 长轮询收消息并回显（占用游标）
```

## push-test.mjs（主动推送回归）

停掉 OneFleet 后运行；等你发一条微信消息捕获 senderId/context_token，然后自动跑三组对照：
T1 带 ctx 即时回复（基线）/ T2 无 ctx 主动发 / T3 带 ctx 延迟 15s 主动发。
**2026-10-17 实测：T1/T2/T3 全部送达**——主动推送无需 context_token，官方完全支持。

协议要点（实测固化）见 docs/HANDOVER.md「外部资源」。
