# W3 交付报告 + BotFleet 竞品实测与路线重评

**日期：** 2026-10-14 晚
**性质：** 按用户指令完成三段式：① 实测 BotFleet → ② 重评原型路线 → ③ 结论不变，采纳 OneFleet 命名、建私有仓库、继续 W3。

---

## 一、路线重评结论：不变（维持 Orkas fork）

### BotFleet 实测记录

| 项 | 结果 |
|---|---|
| 源码 | 152MB tarball，pnpm monorepo（Electron+Vite+server+iOS companion），v1.0.31（main） |
| 安装 | 8m10s 装完（网络受限环境偏慢） |
| 启动 | `pnpm dev:server`（8799）+ `pnpm dev`（5199）✅ Web UI 正常渲染 |
| 引擎 | **要求本机装有并登录 claude/codex/grok CLI**；本机三者皆无 → 但意外发现其 hermes ACP driver 自动读取 `~/.hermes/.env` 的 GLM key，Director bot 跑在 `zai/glm-5.3-flash (Hermes config)` 上（对恰好装过 Hermes 的用户开箱即用，但这不是面向中国用户的产品化路径） |
| UI | 英文 only；Director 单主 bot + rooms + 审批卡 + Trajectory 时间线 + iPhone 伴侣——"运行+远程监督"形态 |
| 工程 | 代码注释质量高、测试多、Apache-2.0、README 诚实自认局限（updater 坏、版本三处不一致、"所有 fork 层功能 in testing"） |

### 重评要点（含一处必须修正的自我声明）

1. **修正声明：**"模板层只有我们有"**不成立**。BotFleet 有完整 Team Library（文件/库/GitHub 三路导入 + 预览 + botfleet.team manifest + BotMRR playbook 包）。修正后的差异化表述：**结构化行为契约**（instructions/standards 分离 + 验收标准 + welcome 任务）+ **模型自动配置**（manifest 内 provider/key 自动建 entry）+ **活会话反向导出** + **国产模型一等公民**。他们的 manifest 是"名册"（name/title/description/color，≤4000 字 persona blob），无以上四项。
2. **决定性权重仍是引擎模型**：BotFleet 重心是 CLI-bot 协调（海外订阅工具），中国 OPC 用户被排除在核心路径外；GLM 理论可达（openai-compat/pi driver）但非 curated 入口。Orkas 的国产模型表单填 Key 是开箱即用（已实测）。
3. **值得抄的两点（吸收进 W4）**：Team Library 的 GitHub 导入交互；BotMRR 的 **Markdown+frontmatter 模板分发格式**——模板可以是一篇带 frontmatter 的文章，在小红书/公众号/博客天然可分发，对"卖编队模板"的分发形态极有启发。
4. BotFleet 的存在验证赛道热度；它 4★/0 fork/52 issues/单人，且把 "BotFleet" 名字和官网占了——我们放弃该名字反而避开正面混淆。

---

## 二、OneFleet 落地

- **私有仓库已建**：`github.com/jayswu/OneFleet`（private，main 分支，2 个 commit 已推送）
- 首个 commit 完整保留上游归属（fork of Orkas-AI/Orkas v2026.10.1, MIT）；W4 换品牌时补 README/NOTICE 的 rebrand
- 内部 rebrand（package.json name 等）留 W4，避免现在大面积改名干扰开发

---

## 三、W3 交付物

| # | 交付物 | 状态 |
|---|---|---|
| 1 | **编队模板 ×3**：solo-growth（一人公司增长组）/ indie-sales（独立开发者销售组）/ competitor-radar（竞品调研组） | ✅ 全部通过解析器校验；12/12 测试（含新增的"出厂模板文件"测试 `team-templates-files.test.ts`） |
| 2 | **嵌入模型国内源修复**：tarball 403 时自动回退逐文件镜像下载（默认 `hf-mirror.com/Qdrant/bge-small-zh-v1.5`，env `ORKAS_EMBEDDING_MODEL_MIRROR` 可覆盖），**逐文件 SHA256+bytes 强校验不降级** | ✅ E2E：googleapis 403 → 镜像 7 文件全部验证 + 安装成功 |
| 3 | **模板库 UI v1**：AI 团队页新增"导入编队模板"按钮 → 文件选择 → `teamTemplates.import` → 自动跳进新会话 | ✅ E2E（CDP 驱动文件选择器实测）：indie-sales.yaml 导入后 3 Agent 并行执行（运行中 3 · 排队 0） |
| — | 成本面板 | ⏸ 移入 W4：`conversation-cost-meter` 是内存 backstop（无持久化、无 per-agent 分账），真正的成本面板需要新建用量持久化管道，超出"只动门面"纪律 |

改动已提交并推送（commit `ff1598e`）。素材归档：`素材/w2-编队模板层/`（含 08/09/10 三张新截图）、`素材/botfleet-竞品实测/`。

---

## 四、下一步（W4 预告）

1. 功能裁剪（video/image/tts/web_assist 工作室，保 generate_image 工具）
2. 换品牌：OneFleet 名字 + 新 logo + README rebrand（含上游归属）
3. 打包（macOS first）+ 开源转 public + **录第一条视频**
4. 成本面板（用量持久化管道）+ 模板库网格 UI（多模板管理）+ 借鉴 BotMRR 的 Markdown 分发格式
5. 竞品档案：BotFleet 纳入常规监测（同赛道最近邻居）
