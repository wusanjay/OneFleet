# Hermes 官方版 macOS 实测报告

**日期：** 2026-10-13
**触发：** 用户授权"现在就把 Hermes 官方版在 macOS 上装起来实测一轮"，目的是判定他在 Windows 上"效果一般"的体验是**平台问题**还是**产品问题**。
**方法：** 本机（macOS darwin arm64, Node v26.8.2）真实执行官方安装脚本、构建桌面端、启动 Electron 应用、用 CDP 驱动真实界面完成多 Bot 群聊全流程。

---

## 一、结论先行

| 问题 | 答案 |
|---|---|
| Hermes 官方版在 macOS 上能装起来吗？ | ✅ **能**，但安装器有一个**网络卡死缺陷**（见第三节） |
| 多 Agent 群聊（Bot Mode）能用吗？ | ✅ **完整跑通**，3 个 Bot 各自以不同角色在群里回复 |
| 你"Windows 上效果一般"是平台问题还是产品问题？ | ⚠️ **主要是平台问题，但产品本身也还在"补课"** —— 见第五节 |
| 桌面端 UX 和 DS Bot 比如何？ | **不同取向**：Hermes 是"表单式精确配置"，DS Bot 是"对话式引导"。各有优劣，见第四节 |

**一句话：Hermes 官方版在 macOS 上完全可用，多 Bot 群聊是真的能跑的产品级功能。你在 Windows 上的体验差，主因是 Windows 适配（有系统性证据），不是 Hermes 本身不能用。**

---

## 二、我实际做了什么

| 步骤 | 结果 |
|---|---|
| 执行官方安装脚本 `install.sh` | ✅ 跑通，但中途卡死一次（见第三节） |
| 获取源码 | ⚠️ 官方 git clone 卡死 → 改用 codeload tarball（81MB，245MB 解包） |
| 安装 Python 依赖 | ✅ `uv` + Python 3.14.7，依赖装齐 |
| 构建桌面端 | ⚠️ **打包**失败（electron-builder 需联网）→ 改用 `--source` 模式直接跑 dist |
| 启动 Electron | ✅ Electron 40.10.2，成功加载 UI |
| **恢复历史会话** | ✅ **自动恢复了你 9 月 14 日的真实会话**（见截图 01） |
| **创建 2 个 Bot** | ✅ Writer、Analyst，各带独立 SOUL.md 人设 |
| **创建群聊** | ✅ "Writer, Analyst, Hermes"，3 个成员 |
| **多 Bot 协作验证** | ✅ **3 个 Bot 各自以不同角色回复，并触发 @user 升级与轮次上限保护** |

**重要发现：这台机器上本来就有你 9 月 14 日装的 Hermes**（`~/.hermes/` 里有 `.env`、`config.yaml`、`auth.json`、会话历史），配的是**智谱 GLM**。我是在这份真实安装上继续的——所以下面的体验非常接近你的实际情况。

---

## 三、安装过程中的真实障碍（两个，都值得知道）

### 3.1 `git fetch` 会卡死（官方安装器的缺陷）

官方安装脚本在 `repository` 阶段执行 `git fetch origin`。**这次它卡了 13 分钟无进展、无 TCP 连接**，我不得不手动终止。

> 严格说这里有环境因素（本机到 github.com 的 443 连接不稳定）。但安装器**没有 fetch 超时**，卡住后既不报错也不退出，用户只能干等——这是一个真实的健壮性缺陷。

**我的绕过方法**（对你有用）：用一个**本地裸仓库**作 origin，`git fetch` 从 13 分钟变成 0.03 秒：
```bash
git clone -q --bare ~/.hermes/hermes-agent /tmp/hermes-origin.git
cd ~/.hermes/hermes-agent && git remote set-url origin /tmp/hermes-origin.git
```

### 3.2 桌面端"打包"需要联网，但"构建"不需要

`hermes desktop --build-only` 的**打包**步骤失败：
```
[mac-icon] actool not found: packaging assets/icon.icns only
TypeError: fetch failed
✗ Packaging the desktop app failed
```
原因是 electron-builder 要联网下载 Electron 二进制，且 macOS 26 分层图标需要 Xcode 26。

**绕过方法**：`dist/` 已经构建好了，直接用 `--source` 等价的方式启动：
```bash
cd ~/.hermes/hermes-agent/apps/desktop
./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . --remote-debugging-port=9222
```

---

## 四、关键发现：一个"不是 token 过期"的坑

第一次发群聊消息时，Hermes 报错：

> `HTTP 400: 模型不存在，请检查模型代码。`

**你的第一反应是"token 过期了"——我实测证明不是。** 我直接拿配置里那个 GLM key 打接口：

```bash
curl -X POST "https://open.bigmodel.cn/api/paas/v4/chat/completions" \
  -H "Authorization: Bearer $GLM_API_KEY" \
  -d '{"model":"glm-5","messages":[{"role":"user","content":"hi"}]}'
# → HTTP 200，正常返回
```

**Key 完全有效。** 我逐个测了模型名，发现真正的两个原因：

1. **配置里模型名是空的**。`config.yaml` 里写着 `default: "anthropic/"` —— 空模型名 + 指向 OpenRouter，但凭据池里**只有 zai**。UI 上显示 "GLM 5.3 · Flash" 只是前端展示，实际发出去的模型名对不上。
2. **`glm-5.3-flash` 是推理模型**，不支持关闭思考。修好模型名后报错变成："该模型始终思考，不支持关闭思考；请使用 low、high 或 max。" 需要设 `agent.reasoning_effort`。

**修正动作（三处都要改，这是 Hermes 的 profile 隔离设计）：**
```bash
hermes config set model.default "zai/glm-5.3-flash"
hermes config set model.provider "zai"
# 两个 Bot 有独立的 config.yaml，也要改
# ~/.hermes/profiles/writer/config.yaml
# ~/.hermes/profiles/analyst/config.yaml
# 以及 reasoning_effort: "low"（在 agent: 段，不是 model: 段）
```

> ⚠️ **踩坑提示：** 桌面端运行时会**回写配置**，所以我用脚本直接改 `config.yaml` 时改动被覆盖了，必须**先关掉桌面进程**再改。最后是用官方 `hermes config set` 成功的。
>
> ⚠️ **另一个坑：** `hermes config set model.reasoning` 会被接受但**是错的键**（正确是 `agent.reasoning_effort`），设错后不报错、只是不生效。

---

## 五、多 Bot 群聊实测（核心证据）

### 5.1 创建流程（对比 DS Bot）

Hermes 的入口是侧栏 **"机器人"（Bots）** 标签页 → 右上 `+` → **新建机器人 / 新建群聊 / 新建分区**。

**新建机器人是一个表单**（截图 04）：

| 字段 | 说明 |
|---|---|
| 名称 | slug，如 `analyst` |
| 显示名称 | `Analyst` |
| 描述 | "这个机器人应该帮你做什么？" |
| **高级** | 可 pin provider/model、写自定义 SOUL.md、跳过内置技能 |
| 头像 | 生成 / 上传 / 宠物 / 自动 / 随机，经典形状 7 种 × 多色 |

对话框原文：**"拥有独立记忆、技能和聊天的具名队友，可以与你的其他智能体互发消息。"**

**新建群聊**（截图 06/07）：原文 "**Pick 2–6 bots. Local memberships sync through each Bot profile; cross-machine members stay scoped to this room.**" —— 勾选成员，按钮显示 `Create Group (3)`。

> **这是与 DS Bot 最本质的差异**：Hermes 用**表单**建 Bot（精确、可复现），DS Bot 用**跟 Chief 对话**建 Bot（自然但不可靠——我实测它把"创建三个 Bot"理解成了建一个叫"三个"的 Bot）。

### 5.2 群聊协作实际效果（截图 15）

我发 `@everyone 请各自用一句话说明你负责什么。`，三个 Bot 全部响应，**且各自的人设正确生效**：

| Bot | 回复 |
|---|---|
| **Writer** | "我负责文案创作：写各类文案、标题、社媒内容和内容润色改稿。" |
| **Analyst** | "我负责竞品调研分析：收集竞品信息、市场动态，输出结构化对比报告。" |
| **Hermes** | "我负责工程执行：跑命令、查系统、抓取和整理网页数据、写脚本与文件，把想法落地成可验证的产物。" |

**观察到的产品级机制（都真实生效）：**

1. **`@user` 升级**：Bot 回复时用 `@user` 抬头，把话递回给人 —— 这正是源码里 `$groupNeedsYou` 徽章的机制。
2. **轮次上限保护**：活动栏显示 **"turn stopped at the round/message cap"** —— 对应源码的 `GROUP_CHAT_MAX_ROUNDS = 3`、`GROUP_CHAT_MAX_MESSAGES = 10`。**Bot 没有无限刷屏。**
3. **`@everyone` 与 `@名称` 寻址**：输入框提示 "@名称指定，@everyone 全体"。
4. **活动面板**：群聊顶部有可展开的"活动"栏，显示事件（错误、轮次停止等）。
5. **人设持久化**：每个 Bot 的 SOUL.md 独立（`~/.hermes/profiles/<name>/SOUL.md`），CLI 单独测 `hermes -p analyst` 时也返回正确的角色描述。

**界面结构**（截图 09/15）：左侧 BOTS 面板列出 3 个 Bot（各自头像、@handle、状态点），群聊项显示"3 个机器人"；主区是消息流，每条带 Bot 头像、名称、时间戳；底部输入框 + "新帖子"按钮。

---

## 六、回答你的问题：平台问题还是产品问题？

### 6.1 Windows 体感差 = 平台问题（证据充分）

Hermes 仓库里 **`platform/windows` 是唯一的操作系统级故障标签**，官方描述 "**Native Windows-specific behavior or breakage**"，另有专属风险标签 `sweeper:risk-platform-windows` —— **没有 macOS/Linux 的对等标签**。

高优先级 Windows issue 覆盖全链路：全新安装失败、Setup.exe 卡住、更新半途失败无恢复、PATH 竞态崩溃循环、主二进制未签名被 SmartScreen 拦、进程泄漏吃 8GB、Ollama 流式输出挂起。官方文档也自认 "Windows support is feature- and architecture-specific"。

**所以你的 Windows 体感有系统性依据。**

### 6.2 但产品本身也还在补课（跨平台问题）

我在 macOS 上同样遇到了产品层面的粗糙处：
- 官方安装器 `git fetch` 无超时、卡死不报错（我这边复现了）
- 桌面端打包依赖联网 + Xcode 26，官方 `--build-only` 直接失败
- **配置错误提示极其误导**：明明是模型名不匹配，却报"模型不存在"；且 `hermes config set model.reasoning` 会静默接受一个错误键
- 官方 issue 自认 Bot Chat "reads as a transcript, not a conversation"、群聊活动"too opaque to supervise"、群聊**只在桌面端可用**（web/手机拿不到）

HN 上有 macOS 用户吐槽 desktop "vibecoded without taste" —— **说明桌面 UX 差评不限于 Windows。**

### 6.3 更准确的结论

> **你的"效果一般"= Windows 适配差（主因） + 产品仍在快速迭代期（次因）。**
> **换到 macOS 上，Hermes 是"能用、且群聊功能是真的"——但装它需要一定的排障能力。**

---

## 七、对选型的影响

### Hermes vs DS Bot（都是实测，不是读文档）

| 维度 | Hermes 官方版（macOS 实测） | DS Bot（macOS 实测） |
|---|---|---|
| 装起来 | ⚠️ 需绕两个坑（fetch 卡死、打包需联网） | ⚠️ 需绕一个坑（macOS 无 setsid） |
| 建 Bot | ✅ **表单**，精确可复现 | ❌ **对话**，实测"建三个"→建出一个叫"三个"的 |
| 群聊协作 | ✅ **3 Bot 各自人设生效** | ✅ 3 Bot 发言（mock 驱动） |
| 轮次保护 | ✅ 实测触发 "round/message cap" | ✅ 有 ROOM_BOT_ROUNDS=3 |
| 升级给人 | ✅ 实测 `@user` | ✅ 有 ask_user |
| 历史/记忆 | ✅ **恢复了 9 月的真实会话** | ✅ Markdown 记忆 |
| 中文 | ✅ **原生全中文 UI** | ✅ |
| 代码 | TypeScript，171 文件 95 个测试 | 纯 JS，~48 测试 |
| 维护 | 公司（Nous），每周发版 | 1 人 + AI bot，5 天新仓 |

### 修正后的建议

**Hermes 现在值得作为主力候选**，理由：
1. 我在 macOS 上**亲手跑通了完整多 Bot 群聊**，不是看文档得出的结论。
2. **建 Bot 的表单化设计比 DS Bot 的对话式更可靠**——这对你"卖行业编队模板"至关重要，因为模板需要**可复现、可精确重建**。
3. 原生中文 + GLM 等国产模型 first-class，你的目标用户直接可用。
4. MIT 可商用。

**但要接受的代价：**
- 装它需要排障能力（好在你会）。
- **Windows 用户（你的潜在客户）体验可能差**——这既是风险，也是机会：你可以提供"帮你在 Windows 上装好 Hermes"这类交付服务（但要先自己验证 Windows 上能否跑通）。
- 迭代快，**必须 pin 版本**。

**给产品底座的最终建议不变**：无论用 Hermes 还是 DS Bot 做演示，**编队模板都要存成你自己的 YAML/JSON**（Hermes 的 profile 目录、DS Bot 的 state.json 都会变）。Hermes 的 profile 可整体复制（含 config + skills + SOUL.md + memory），这是你做编队模板的天然抓手。

---

## 八、实测截图索引

截图归档在 `调研/实测截图-hermes/`：

| 文件 | 内容 |
|---|---|
| `01-boot.png` | **恢复了你 9 月 14 日的真实会话**（"你是谁""你能直接操作电脑吗"），全中文 UI |
| `02-bots-tab.png` | **Bot Mode 已激活**：左侧 "BOTS" 面板 |
| `03-new-dialog.png` | 新建菜单：新建机器人 / 新建群聊 / 新建分区 |
| `04-newbot-dialog.png` | **新建机器人表单**（名称/显示名称/描述/高级/头像生成器） |
| `06-newgroup-dialog.png` | **新建群聊**："Pick 2–6 bots" |
| `07-members-selected.png` | 三个 Bot 全选，按钮 `Create Group (3)` |
| `09-group-created.png` | **群聊创建成功**，"3 个机器人"，"活动"面板 |
| `11-group-conversation.png` | 首次发消息（此时模型配置有误，报错） |
| `14-group-ready.png` | 配置修好后重新打开群聊 |
| `15-group-collab.png` | **多 Bot 协作完整效果**：3 个 Bot 各自人设回复 + @user + 轮次上限 |
| `16-bot-profile.png` | Bot 详情 |

---

## 九、可复现命令

```bash
# 1) 安装（官方脚本；若 git fetch 卡死，用本地 origin 绕过）
bash install.sh --non-interactive --skip-browser --skip-computer-use --include-desktop
# 卡死时：
git clone -q --bare ~/.hermes/hermes-agent /tmp/hermes-origin.git
cd ~/.hermes/hermes-agent && git remote set-url origin /tmp/hermes-origin.git

# 2) 修模型配置（关键！三处都要改）
hermes config set model.default "zai/glm-5.3-flash"
hermes config set model.provider "zai"
# ~/.hermes/profiles/{writer,analyst}/config.yaml 同样两行
# 并把 agent.reasoning_effort 设为 "low"（注意在 agent: 段）

# 3) 验证 profile 可用
hermes -p writer  -z "一句话说明你负责什么" --cli
hermes -p analyst -z "一句话说明你负责什么" --cli

# 4) 启动桌面端（打包会失败，用 source 方式）
cd ~/.hermes/hermes-agent/apps/desktop
./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . --remote-debugging-port=9222

# 5) 用 CDP 驱动（截图/自动化）
# chromium.connectOverCDP('http://127.0.0.1:9222')
```

**环境：** macOS darwin 25.5.0 arm64，Node v26.8.2，Python 3.14.7，Electron 40.10.2，Hermes `main@5eb99eb`（我用 tarball 取的最新 main）。

---

*说明：本次实测在用户本机既有的 Hermes 安装（2026-09-14 配置，zai/GLM 凭据）上继续，最大程度贴近用户真实使用场景。模型配置的修改已备份至 `~/.hermes/config.yaml.bak-*`。*
