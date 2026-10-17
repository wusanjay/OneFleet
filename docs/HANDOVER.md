# OneFleet 交接文档（HANDOVER）

> 给下一台电脑 / 下一个 AI 的完整交接。硬规范在根目录 `AGENTS.md`（每会话自动加载）；
> 本文档回答"为什么这么做"和"现在到哪了"。最后更新：2026-10-17。

## 一、这个项目是什么

**OneFleet** — 本地优先的多 Agent 编队工作台，产品定位「机器人版飞书」：

- 用户导入一份编队模板（YAML），一键生成一支机器人员工队伍（3-6 个角色化 bot）+ 群聊房间 + 首个任务
- IM 三栏界面：左侧功能 rail / 中栏会话与员工列表 / 右栏聊天区；机器人是"员工"，有状态灯、交付物卡、成本里程碑
- 微信远程：扫码把值班机器人装进微信，手机发消息即可指挥电脑上的编队干活
- 商业方向：面向独立开发者/一人公司的 C 端产品；个人 IP 内容引流 → 开源+免费+增值

**身世**：2026-10 风口调研（OpenClaw 爆火 → 多 Agent 协同将成为国内下一个风口）→ 评估 DS Bot / Hermes / Orkas 后选定 **Orkas-AI/Orkas**（MIT，Electron 单体，pi-ai 内核）为底座 fork → W1-W4 改造 → 微信渠道 → rebrand OneFleet。

## 二、产品决策记录（决策 + 原因）

| 决策 | 原因 |
|---|---|
| 弃 OpenClaw gateway，直连微信官方 iLink API | gateway 全家桶过重（12G 源码树、插件体系、宿主版本锁）；ZCode 证明了直连 iLink 只要 ~1200 行。腾讯给 OpenClaw 出的 ClawBot 插件只是 iLink 协议的封装 |
| 微信通道走 iLink 而非个人微信协议 | 个人微信无官方 API（第三方协议有封号风险）；iLink 是微信官方机器人平台（ClawBot 同源），`ilinkai.weixin.qq.com/ilink/bot/*`，扫码即用无审核 |
| bot_token 视为长期凭据 | ZCode 持久保存无刷新逻辑；实测长期有效。失效兜底：401/403 → 停循环 → 面板"已断开" → 重扫 30s 恢复 |
| **bot_id 每次扫码都会变** | 实测确认（按扫码会话签发）。重扫 = 新的微信机器人对话，旧对话失效。产品无碍，但演示录制前先扫码、中途勿重连 |
| 点「远程」不自动开对话 | 远程是控制面（配置渠道），扫码/绑定不产生会话线程；强行开会制造空会话。真实会话走消息列表。要右栏详情做独立 Remote panel（已做：panel-remote），不复用 conversation view |
| 远程模式中栏收起会话列表 | 用户实测反馈突兀；微信消息入口只在右栏管理页一处，不重复 |
| 内部保留 `ORKAS_*` 命名 | 上游合并成本是硬约束。只改了 productName/图标/容器目录（~/.onefleet，一次性迁移） |
| 渠道抽象 `ChannelAdapter` | 必选方法压到最少（beginLogin/pollLogin/test/pollInbound/sendText），能力差异用可选方法表达。参考 ZCode BotProviderAdapter。飞书/Telegram 未来各几百行 |
| 微信回复用普通文本 | iLink 渠道只支持文本粒度（streaming card 是飞书专属）；typing 用 `/sendtyping` 每 5s 续期（状态自动过期） |

## 三、状态账本

### 已完成
- W1 架构评估与本地运行；W2 编队模板层（YAML ⇄ 一键建队，roundtrip）；W3 三支演示编队 + BotFleet 竞品实测；W4 P1 三栏 IM 布局、P2 状态灯/交付物卡/成本里程碑卡、P2.5 计划先行契约
- R1 员工列表（中栏机器人 tab = 全量名册）、编队注册表、术语统一（机器人）
- 微信渠道全链路（iLink 直连、扫码 UI、panel-remote 管理页、typing、zai 国内端点别名、品牌图标），**用户实测全通**
- rebrand（93b052f）：productName OneFleet、新章鱼图标、容器 ~/.onefleet 迁移、打包 cjs 修复
- 发布产物：arm64 DMG + ZIP（含微信渠道），打包版验收通过（菜单栏 OneFleet、循环自启、数据与源码版共享）
- 录像分镜脚本：docs/research/OneFleet-发布视频分镜.md
- 重连保留绑定：disconnect 只失效凭据（token 空 + enabled=false），保留 botId/agentId/cid；重扫经 updateAccount 合并复用原 DM（游标随断开重置防跳消息）。单测 test/main/features/channels-reconnect.test.ts

### 待办（按优先级）
1. 录发布视频（分镜已备；注意先扫码、勿中途重连）
2. 转 public + GitHub Release（挂 dist 产物）+ 三平台同名账号
3. 成本面板按 actor 归因（W5 遗留，需 runner→AgentRunner 线程穿透）
4. 员工卡片聚合（每机器人的成本/例程/交付物）
5. 渠道矩阵：飞书 / Telegram adapter
6. 打包 x64 target（曾时间盒止损：ensure-runtime darwin-x64 失败链）
7. 微信群聊能力实测（协议有 chatType:group 字段，能力面未知）

### 已知坑速查（详见 AGENTS.md 陷阱清单）
打包清 runtime / forceCodeSigning / CDP 加固 / 单实例锁顶替 / bot_id 变更 / CSS flex 覆盖 hidden / createCustomAgent 顶层选项 / zai→CN 别名。

## 四、新机启动清单

```bash
git clone https://github.com/jayswu/OneFleet.git && cd OneFleet
npm install
node bin/ensure-runtime.cjs --kind node    # bundled node runtime（缺了模型调用会报错）
export GLM_API_KEY=sk-...                  # 模型 key（智谱，国内端点）
npm start                                  # 源码版启动
```

- 模型配置：设置 → 模型 → 添加 zai（智谱）key；`PI_MODEL_PROVIDER_ALIAS` 已指向国内端点，无需代理
- 微信接入：左侧「远程」→ 扫码接入微信 → 值班机器人下拉任选 → 微信里给新出现的机器人发消息即通
- 运行时数据全在 `~/.onefleet/data/`（微信 token、模型凭据、会话），**不在代码库里**，换机自然从零开始
- 打包：`npx electron-builder --mac --arm64 -c.mac.forceCodeSigning=false`，产物在 `dist/`（不入 git，走 GitHub Release 分发）

## 五、外部资源

- ZCode 参考实现（微信 iLink 协议 + bots 架构，Apache 2.0）：本机曾 clone 于 `~/Documents/workspace/github/ZCode`（zai-org/ZCode），核心文件 `packages/services/src/bots/providers/weixin*.ts`、`docs/bots.md`
- 微信 iLink 协议要点（实测固化）：容器字段 `msgs`；`message_type` 1=用户 2=bot 回显（丢弃防自循环）；收消息 `getupdates` 长轮询 90s + `get_updates_buf` 光标；发消息 `sendmessage`（`from_user_id` 填 bot_id，文本放 `msg.item_list`）；回复需带 inbound 的 `context_token`；typing 两步（`getconfig` 取 typing_ticket → `sendtyping`）
- 上游：Orkas-AI/Orkas（我们的 PR #112 OPEN、#113 候选）
- 竞品坐标：Grok Bot（机器人为主对象）、Manus Cue（agent 身份/团队群聊）、Hermes（单会话壳+编队核）、BotFleet（同赛道 fork，命名冲突已弃用其名）
