# AGENTS.md — OneFleet 开发约定

> Fork 自 Orkas-AI/Orkas（MIT）。产品名 OneFleet：本地优先的多 Agent 编队工作台（"机器人版飞书"）。
> 产品决策、历史脉络、新机启动清单见 **docs/HANDOVER.md**（改产品行为前必读）。

## 身份与环境

- Git 提交身份固定：`Jayden <wusj007@gmail.com>`（禁用公司邮箱；全局 git config 不可依赖，提交时用 `-c` 显式指定）。
- GitHub 直连经常 443 超时；推送用 `git -c http.proxy=http://127.0.0.1:7897 -c http.version=HTTP/1.1 push`（本机 Clash 端口 7897，系统代理常开但 git/curl 默认不吃系统代理）。
- 模型 key 走环境变量 `GLM_API_KEY`（启动应用前设置）。

## 常用命令

```bash
npx tsc --noEmit                # 主进程类型检查
npx vitest run test/...         # 单测（vitest）
npm start                       # 源码版启动（tsx 直跑，无编译步骤；renderer 从 src 直载）
node bin/ensure-runtime.cjs --kind node   # 装/修 bundled node runtime
npx electron-builder --mac --arm64 -c.mac.forceCodeSigning=false  # 打包（无证书机器；ad-hoc 签名由 afterPack 兜底）
```

## 关键陷阱清单（踩过的坑，勿再踩）

1. **createCustomAgent 的指南数组（knowhow/standards）必须作为顶层选项传入**，嵌在 profile 对象里会被 normalizeAgentProfile 的外部键优先级静默丢弃。
2. **zai 供应商已别名到国内端点**：`PI_MODEL_PROVIDER_ALIAS['zai'] = 'zai-coding-cn'`（open.bigmodel.cn）。海外 api.z.ai 从 CN 网络不可达（连代理都 000），勿改回。
3. **CSS 作者级 `display:flex` 会覆盖 HTML `hidden` 属性**——flex 容器必须显式 `[hidden]{display:none}`，否则 hidden 失效。
4. **打包/清场流程会删 `resources/runtime/<platform>`**：模型调用报 "Bundled Node runtime is required" 时，跑 `node bin/ensure-runtime.cjs --kind node` 后重启。
5. **CDP 不可用**：应用安全加固导致 `/json/list` 恒空。UI 验收走「截屏 + CGEvent 合成点击」（`/tmp/click.swift` 模式）或数据面直查（`~/.onefleet/data/`）。注意 screencapture 截图是 2x，CGEvent 坐标是逻辑像素（除以 2）。
6. **微信 iLink 的 bot_id 每次扫码都会变**（按扫码会话签发）——重新扫码 = 新的微信机器人对话，旧对话失效。录制演示前先扫码，中途勿重连。
7. **中栏模式契约**：`midbar.mode-remote` class 隐藏默认消息头部；`setView()` 统一负责进出模式（防残留）；新增 rail 模式必须同时在 boot.js setView 里清理。
8. **单实例锁**：源码版与打包版、新旧实例会互相顶替（表现为"点了没反应/改动不生效"）。排查时先 `pgrep -f "MacOS/Electron \."` 确认真的是新进程。
9. **上游同步**：刻意保留 `ORKAS_*` 内部命名与环境变量（仅改 productName/图标/容器），**不要**全面重命名——上游合并成本是硬约束。

## 结构速览

- `src/main/features/` — 主进程功能模块（chats、group_chat 总线、agents、channels=微信远程、team_templates=编队模板）
- `src/main/features/channels/` — 渠道抽象（ChannelAdapter）+ 微信 iLink 协议实现
- `src/core-agent/` — agent 内核（pi-ai 体系），上游风格注释
- `docs/HANDOVER.md` — 交接文档：产品决策及原因、状态账本、新机启动清单
- `docs/research/` — 风口调研、竞品实测、设计讨论稿、视频分镜
