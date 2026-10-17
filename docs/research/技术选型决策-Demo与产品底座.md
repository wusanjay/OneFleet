# 技术选型决策备忘（v2 · 纳入 Hermes）

**日期：** 2026-10-12
**背景：** 承接 `独立取证-多Agent协同风口与执行方案.md`。用户补充了一个关键信息：**"Hermes 的 desktop 我实际用过"**。本版据此把 Hermes 纳入候选，重做同口径对比，并修正 v1 的推荐。
**方法：** 3 路独立技术尽调（GitHub API 直连实测 + 仓库源码/测试文件/官方文档逐条核对），star、版本、issue 数均为 2026-10-12 抓取。

---

## 一、v1 推荐被修正（先讲变化）

v1 的结论是"**Demo 用 DS Bot，产品用 OpenClaw 原生或 fork Orkas**"。

**纳入 Hermes 后，这个双轨方案可以合并成一条：Hermes 同时胜任 Demo 与产品底座，且比 DS Bot 和 Orkas 都更合适。** 理由是它**唯一同时满足**"多 Agent + 群聊 UI + 桌面 + 本地优先"四个条件，且**官方 MIT 可商用**、**公司维护**、**原生中文**——而这三条恰好是 DS Bot（v0.1 预览、5 天新仓、只测过 Linux）和 Orkas（社区小、单人主导）的短板。

**DS Bot 从"推荐的 Demo 道具"降级为"不必需"**——Hermes 的 Bot Mode 做了同样的事，但更成熟、有测试、有官方维护。

---

## 二、Hermes 身份消歧（这一步很重要，因为"Hermes"有多个对象）

| 对象 | 仓库 | 许可 | Star | 判断 |
|---|---|---|---|---|
| **Hermes Agent（官方内核 + 官方桌面端）** | `NousResearch/hermes-agent` | ✅ **MIT** | **252,959** | **推荐用这个** |
| Hermes Bot Mode（群聊插件，**已归档**） | `NousResearch/Hermes-Bot-Mode` | ✅ MIT | 668 | 已内置进官方桌面端，无需单独装 |
| Hermes One（社区桌面端） | `fathah/hermes-desktop` | ✅ MIT | 14,396 | 可用的社区壳，`hermesone.org` |
| **Hermes Agent CN Desktop（中文社区桌面端）** | `Eynzof/Hermes-CN-Desktop` | ⚠️ **PolyForm Noncommercial 1.0.0** | 1,749 | **商用禁区，见下方警告** |
| Hermes 3 / Hermes 4（模型系列） | — | — | — | 是模型不是产品，非用户所指 |
| `facebook/hermes`（JS 引擎）、`matcornic/hermes`（Go 邮件模板） | — | — | — | 同名无关 |

> ⚠️ **需要你确认一件事：你实际用的是哪一个 desktop？**
> 如果你用的是 **Hermes Agent CN Desktop**（中文社区那个，`hermesagent.org.cn` 分发，Windows 优先、Tauri+Rust），它的许可是 **PolyForm Noncommercial 1.0.0**，原文明确："**Commercial use, commercial distribution, commercial integration, hosted resale, or use as part of a commercial product or service requires a separate commercial license from Qingdao Wanderminds Network Technology Co., Ltd.**"（青岛万德缦思网络科技有限公司）。
> **这不影响你做 Demo，但如果你想把它当产品底座，必须换成官方 MIT 版本。** 两者的内核是同一个 Hermes Agent，迁移成本不高，但这个法律区别是硬约束。

---

## 三、Hermes 关键事实（已逐条核实）

### 3.1 基本信息

| 项 | 值 |
|---|---|
| 仓库 | `NousResearch/hermes-agent`，描述 "The agent that grows with you" |
| 许可 | **MIT**（`Copyright (c) 2025 Nous Research`）—— 可商用、可闭源分发 |
| Star / Fork | **252,959 / 54,786** |
| 语言 / 建仓 / 最后推送 | Python（monorepo）/ 2025-07-22 / **2026-10-12** |
| 官网 | https://hermes-agent.nousresearch.com （桌面下载页 `/desktop`） |
| 桌面端 | **官方 Electron**，在 monorepo `apps/desktop`；macOS（Apple Silicon，Intel 需专门构建）/ Windows（MSIX）/ Linux（AppImage/deb/rpm） |
| 维护方 | **Nous Research 公司**（非个人）；头部贡献者 teknium1（20,541 commits） |
| 版本节奏 | 约 **38 个 release**，**近乎每周一版**；最新 `v0.21.7`（2026-10-12），`prerelease=false` |

### 3.2 群聊机制（这是它最强的地方，原文核实）

Bot Mode 已是**官方桌面端内置、默认开启**的插件（Settings → Plugins 可切换），代码在 `apps/desktop/src/plugins/hermes-bots/`。README 原文（`Hermes-Bot-Mode`）：

> **Group chats** — hit **Open chat** on any group header (2-6 bots) for a shared room where the whole group coordinates. Your message triggers up to three serial rounds of member turns: @mentioned bots respond (everyone when nobody is mentioned), each bot replies briefly or passes, and the room settles when a full round stays silent. Bots pull each other in with @name, escalate real judgment calls with @user (the group header shows a **needs you** badge), and hard caps (10 messages per turn, 3 rounds) keep rooms from spinning. Each bot keeps its own persistent `Group: <name>` session, so room context survives like any other conversation.

拆解出五个**产品级设计**，这些恰好是你做"多 Agent 群聊"最难的部分，它已经解决了：

1. **Bots pane**：左侧名册，一行一个 Agent（头像、最新消息预览、时间戳），右键可看该 bot 最近 200 条会话。
2. **Active now 在线状态条**：显示当前在干活的 bot（gateway busy 的 + 90 秒内写过消息的），空闲时自动消失。**这直接解决"看不出 Agent 在不在干活"的演示痛点。**
3. **发言预算与轮次上限**：每轮最多 10 条消息、最多 3 轮，空轮即收敛。**这是 Token 爆炸的工程解法**（和 DS Bot 的"管理员 Bot 默认回复"是同一类思路，但更显式）。
4. **bot 互相拉人 + 升级给人**：bot 可用 `@name` 把同伴拉进来；遇到真正需要判断的事用 `@user` 升级，群头部显示 **needs you** 徽章。**这正好对应合规要求的"高风险动作人工确认"。**
5. **持久群会话**：每个 bot 保留自己的 `Group: <name>` session，房间上下文像普通会话一样留存。

**代码有完整测试覆盖**（`group-chat.ts`、`group-rounds.ts`、`group-turns.ts`、`relay.ts`、`group-presence.ts`、`group-membership.ts`、`roster-pane*.tsx` 等数十个模块 + 同名 `.test.ts`）——**这不是 demo 级实现，是产品级实现。**

### 3.3 四条件核对（与 v1 同口径）

| 条件 | Hermes | 证据 |
|---|---|---|
| **多 Agent** | ✅ 强满足 | Agent = profile，`~/.hermes/profiles/<name>/` 下**独立 config / memory / skills / credentials / 聊天历史**；每个可写自己的 `SOUL.md` 人设、可 pin 不同 provider/model。有协调者概念：Bot Mode 的编排、`role="orchestrator"` 子代理、`delegation.max_spawn_depth` |
| **群聊/可视化** | ✅ 强满足 | 见 3.2，官方内置、2–6 bot 同房间、@mention、presence 条、needs-you 徽章 |
| **桌面 + 本地优先** | ✅ 满足 | 数据在 `~/.hermes`，会话检索用 **SQLite FTS5**；本地模型支持 **Ollama / LM Studio / vLLM / llama.cpp / LocalAI**；国产模型 **DeepSeek / Qwen(含 alibaba-cn) / GLM(zai) / Kimi / MiniMax-CN / 小米 MiMo** 均为 first-class provider，**BYO keys 无锁定** |
| **工作流 DAG / 模板 / 技能扩展** | ⚠️ 部分满足 | **无 DAG**：官方文档明确 "Grouping controls result delivery, not execution order: all tasks still run in parallel"，需要依赖就顺序派发。**有**：Skills（兼容 `agentskills.io` 开放标准）、**MCP 集成**、插件目录、cron 定时任务、Kanban（含 per-task model override）。**无"行业编队模板"市场**——但 profile 可整体 Duplicate（克隆 config + skills + SOUL.md + memory），这正好是你编队模板的落地抓手 |

---

## 四、五候选同口径对比

| 维度 | **Hermes（官方）** | DS Bot | OpenClaw 原生 | Orkas | LobsterAI |
|---|---|---|---|---|---|
| Star | **252,959** | 1,133 | 391,744 | 2,166 | 6,107 |
| 许可 | ✅ **MIT** | ✅ Apache-2.0 | ✅ MIT | ✅ MIT | ✅ MIT |
| 多 Agent | ✅ profile+orchestrator | ✅ Chief+bots | ✅ bindings | ✅ Commander+专家 | ⚠️ 隔离助手 |
| **群聊 UI** | ✅ **内置 2–6 bot** | ✅ 内置 | ⚠️ broadcast（experimental，走 IM 无桌面 UI） | ✅ 核心模块 | ❌ **无** |
| 桌面端 | ✅ 官方 Electron | ⚠️ 寄居 DSH 桌面 | ✅ 多端 | ✅ Electron | ✅ Electron |
| 本地优先 | ✅ SQLite FTS5 | ✅ | ✅ | ✅ SQLite | ✅ SQLite |
| 中文 | ✅ **官方 zh + 社区** | ✅ | ⚠️ | ❌ | ✅ |
| 维护方 | **公司**（Nous） | 个人 + AI bot | 基金会 | 单人主导 | 公司（网易） |
| 版本节奏 | 每周一版 | 5 天新仓 | 快 | 中 | 每日 |
| **churn 风险** | ⚠️ 高（见下） | ⚠️ 极高（宿主 alpha） | 中 | 低 | 中 |
| DAG | ❌ | ❌ | ⚠️ | ⚠️ | ❌ |
| 模型锁定 | ✅ BYO keys | ✅ | ✅ | ✅ | ✅ |
| **综合** | **🥇 4/5** | 2/5 | 4/5 | 3/5 | 2/5（群聊缺失） |

### 关于 Hermes 的 churn 风险（必须知道，但不必恐慌）

我实测了 issue 口径：**open issue 15,104 + open PR 32,924**（GitHub 的 `open_issues_count` 显示 48,031 是两者之和）。这个数字很大，但要注意它的性质——从标题看绝大多数是 `fix(...)`/`feat(...)` 形式的**开发 PR**，说明这是**极高强度的开发仓库**（teknium1 一人 2 万次提交、大量自动化 PR），不是"积压了 4.8 万个 bug"。

**对比参照：** OpenClaw open issues 9,543、Orkas 仅 11、DSH 0。

**结论：** Hermes 的成熟度是"功能强 + 迭代猛"，不是"功能弱 + 没人管"。**应对方法就是 pin 一个 tag**（如 `v0.21.7`），别跟着 main 跑。

---

## 五、修正后的推荐

### 🥇 首选：Hermes 官方 MIT 版（Demo + 产品共用一套）

**为什么它取代了 v1 的双轨方案：**

1. **群聊开箱即用**，且是产品级实现（有测试、有 presence、有轮次预算、有 needs-you 升级）——**录 3 分钟视频基本不用自己写 UI**，这一点和 DS Bot 一样省事，但成熟度高一档。
2. **MIT + 公司维护**，可以放心做商业产品，不像 DS Bot 那样绑在一个 alpha 宿主上。
3. **原生中文**（官方文档 + UI 语言切换 + 社区站），你的目标用户是国内个体/小商家。
4. **BYO keys + 国产模型 first-class**，边际成本≈0 的模式天然成立。
5. **你已经用过它**——学习成本已经付过了，这是别人没有的起跑优势。

**你要自己补的（和 v1 结论一致）：**
- **行业编队模板层**：Hermes 没有"编队模板市场"，但 profile 可整体 Duplicate。把"跨境电商选品四人组"做成**一套 profile 包 + SOUL.md + skills**，用你自己的 YAML/JSON 描述，可一键重建。**这是你唯一守得住的东西。**
- **DAG/流程可视化**（可选）：群聊是"轮次驱动"不是"图驱动"。如果演示需要流程图，得自建。
- **成本与权限面板**：把 Token/耗时/失败做成看板（Hermes 有 per-task model override，可挂在此之上）。

**立刻要做的动作：**
1. **pin 版本**：`git checkout v0.21.7` 或锁住当前 tag，别跟 main。
2. **确认你用的是官方 MIT 版，不是 CN 桌面版**（见第二节警告）。
3. 装好后直接开 Bot Mode，建 2–3 个 bot 开一个群，**验证 2–6 bot 群聊在你的机器上跑得动**，然后就能录第一版视频了。

### 🥈 备选：OpenClaw 原生（若 Hermes 的 churn 变成实际困扰）

MIT、391k★、稳定；`broadcast-groups` 与 `multi-agent routing` 是已有原语（虽 experimental）。代价是**群聊 UI 要自己从零做**（OpenClaw 有原语无桌面群聊界面）。适合你后期想完全掌控产品形态时用。

### 🥉 备选：fork Orkas（若你想最快拿到"可改造的群聊产品"）

MIT、2,166★、open issues 仅 11、群聊是核心模块。适合你想直接改一个现成群聊产品而非用 Hermes 的形态。

### 降级 / 排除

| 项目 | 结论 |
|---|---|
| **DS Bot** | **降级为不必需**。Hermes Bot Mode 做同样的事且更成熟。除非你想蹭"DeepSeek Bot"这个热点词做内容，否则不必绕这一道 |
| **LobsterAI** | **仍排除**：无群聊（官方 spec 原文"用户期望 A2A 群聊 → 本功能不覆盖"），与网易官方团队版对撞，IP 叙事降级 |
| **cc-haha** | **仍排除**：`package.json` name = `claude-code-local`、引用 `USER_TYPE==='ant'`，是对 Claude 的逆向分发，法律来源不清 |
| **ekko-studio** | **仍排除**：BSL 1.1，商业使用需单独授权 |
| **AgentTeams** | **仍排除**：需 Docker + 2C4G + 浏览器，非桌面端 |
| **AionUi** | **暂缓**：主仓库自 2026-09-09 停更 5 周（后端 AionCore 仍活跃，疑似迁移），fork 前需确认发布模式 |
| **Hermes CN Desktop** | **仅限非商用**：PolyForm Noncommercial，商用需青岛万德缦思单独授权 |

---

## 六、无论选哪个，三件事不变（v1 结论保留）

1. **编队模板存成底座无关的 YAML/JSON**，不要用任何一家的原生格式。Hermes 的 profile、DS Bot 的数据格式、DSH 的配置都会变——**你的"行业编队 Know-how"必须能一键迁移到任何底座。**
2. **编排层抽象成可替换接口**：
   ```
   AgentRuntime（可替换：Hermes / OpenClaw / DSH）
     spawn(role, {model, tools, workspace, memoryScope}) -> AgentHandle
     send(handle, message) / events(handle) -> Stream<...>
     approve(handle, requestId, decision) / cancel(handle)
     capabilities() -> {acp?, mcp?, sandbox?, subagents?, groupChat?}
   TeamOrchestrator（你的差异化层）
     plan(goal) / delegate / mailbox / taskBoard / sharedMemory / roundPolicy
   TeamStore（本地 SQLite）
     teams / members / tasks / messages / runs / artifacts
   ```
   Hermes 的群聊原语比 DSH 丰富（有轮次、presence、升级机制），所以 Hermes 侧编排层可以更薄。
3. **第一天做 go/no-go**，但验证清单换成 Hermes 版：
   - 装官方桌面端，pin `v0.21.7`
   - 建 3 个 bot（主管 + 写手 + 分析师），配 DeepSeek/Qwen 的 Key
   - 开一个群，测：@mention 是否触发指定 bot、bot 之间能否 `@name` 互相拉人、`@user` 是否出现 needs-you 徽章、轮次上限是否生效
   - 跑一个真实任务（如"给我一份竞品分析"），看能否收敛并汇总

---

## 七、一句话回答

> **Hermes（官方 MIT 版）现在是首选，Demo 和产品共用一套——它唯一同时满足"多 Agent + 群聊 UI + 桌面 + 本地优先"，还是 MIT、公司维护、原生中文，而且你已经用过。**
>
> **DS Bot 不必绕了；LobsterAI 仍排除；OpenClaw 和 Orkas 留作备选。**
>
> **一个硬提醒：先确认你用的是官方 MIT 版，不是 CN 桌面版——后者是 PolyForm Noncommercial，商用要单独授权。**
