# Orkas 改造评估（第 1 周产出）

**日期：** 2026-10-13
**性质：** "编队模板播放器"项目的 Week 1 交付——源码已跑通、核心模块已精读、改造方案定稿。
**位置：** 源码在 `orkas-lab/orkas/`（v2026.10.1，已安装依赖、Electron 42.11.9 已跑通、smoke 测试通过、GUI 正常启动）。

---

## 一、结论先行

1. **改造策略定为：整体 fork + 按功能裁剪，不做外科手术式模块抽取。**
2. **代码质量超出预期**，是三人团队级别的水准（注释里带设计决策和实战坑记录），核心编排骨架可直接复用。
3. **产品远比"多 Agent 群聊"大**：33 万行、145 个功能文件，含视频工作室、图片工作室、TTS、web_assist 等成套功能——这些是裁剪对象，不是负担（功能有开关机制，可先开发后裁剪）。
4. **国产模型一等公民**：provider 目录直接内置 deepseek / zai（智谱）/ moonshot / kimi-coding / minimax-CN / doubao，正是"用户自带 Key"模式需要的。
5. **两个国内用户必踩的坑已发现**（Electron 下载、嵌入模型 403），都要在我们版本里修掉。

---

## 二、实测记录（本机跑通）

| 步骤 | 结果 |
|---|---|
| 源码获取 | codeload tarball 56MB（git 通道不稳，同前） |
| `npm install` | 353 个包，成功；但 postinstall 两个脚本失败（见下） |
| Electron 二进制 | 官方源超时 → **用 npmmirror 镜像成功**（42.11.9） |
| SQLite ABI 重编译 | better-sqlite3 按 Electron ABI 重建，成功 |
| 嵌入模型（bge-small-zh-v1.5，95MB） | **`storage.googleapis.com` 返回 403**，国内网络拉不到（待修） |
| `npm run smoke` | **通过**（存储原子性、提示词模板渲染等） |
| GUI 启动 | **成功**，原生中文界面，自动装了 7 个市场 Agent |
| 界面验证 | 新任务 / AI 团队 / 技能库 / 连接器 / 资料库 / 应用 全部渲染正常（截图归档） |

> 嵌入模型只影响"资料库"的本地向量检索，不影响群聊编排核心，可延后修。

## 三、架构地图（精读产出）

```
┌─ src/main（20.0 万行，Electron 主进程）
│   ├─ features/（145 个功能文件）
│   │   ├─ group_chat/（1.8 万行 ★ 核心）
│   │   │   ├─ bus.ts        10,870 行：消息总线 = 编排心脏
│   │   │   ├─ state.ts       1,189 行：成员名册（commander/user/agent/worker）
│   │   │   ├─ router.ts        727 行：@提及解析（含 CJK 边界处理）
│   │   │   ├─ task_board.ts    934 行：会话级任务板（纯宿主状态机）
│   │   │   ├─ visibility.ts    726 行：消息 schema 与模型历史投影
│   │   │   └─ index.ts       1,575 行：IPC 门面
│   │   ├─ agents.ts        3,367 行：Agent 名册 + per-agent model_override + 表单创建
│   │   └─ ...（video_studio 5,778 行等 142 个 = 裁剪对象）
│   ├─ model/（provider_catalog：deepseek/zai/moonshot/kimi/minimax-CN/doubao/openai/anthropic/google/openrouter/custom）
│   └─ ipc/ storage/ paths/ util/
├─ src/core-agent（5.8 万行 ★ 从 OpenClaw 简化抽取的 Agent 运行时）
│   ├─ providers/（pi-ai 库：显式处理 deepseek/zai 思考格式）
│   ├─ agent/（AgentRunner、Session、上下文预算模型推导）
│   ├─ memory/（FTS5 + 本地 ONNX 向量 bge-small-zh-v1.5 混合检索）
│   ├─ skills/ sandbox/ tools/ evolution/（自我进化：COMPETENCE.md 回喂）
│   └─ config/
└─ src/renderer（7.2 万行，81 个模块，原生中文）
```

**编排设计亮点**（README「工作原理」与源码互证）：
- **三个派发动词**：`hand_off_to`（交给专家，回合结束）/ `dispatch_to`（派发并等结果继续）/ `run_worker`（私有子任务）——指挥官必须先说出下一步才能 dispatch，从机制上防止"复述式收尾"。
- **单一运行时有界扇出**：会话级 FIFO 串行，并行只在回合内（`dispatchSlots=4`），死锁被构造排除。
- **上下文预算由模型推导**：同一套策略适配 32K–1M 窗口，不用写死数字。
- **四道失控保护**：轮次上限（100 回合计数制）、每回合工具轮数（指挥官 120/专家 100）、循环检测、工具空闲看门狗。
- **对比实测过的两家**：Hermes 的轮次保护是"3 轮 10 条消息"，Orkas 是"100 回合 + 工具预算"——Orkas 的粒度更细，更适合真实工作任务而非寒暄式群聊。

## 四、改造策略：为什么是"整体 fork + 裁剪"

**否决"抽取 group_chat + core-agent 自建轻壳"**：bus.ts 与 features 层耦合较深（imports reflection-coordination、conversation_filing、conversation_history_cache、project-layout、local_agents 等十余个兄弟模块），抽取是高风险手术，而且会丢掉测试、i18n、打包、自动更新这些工程资产。

**采用"整体 fork + 裁剪"**：
1. 功能是按文件组织的（145 个文件边界清晰），裁剪 = 删文件 + 删导航入口，机械可验证（typecheck + smoke 兜底）。
2. 裁剪不阻塞差异化开发：功能有 `component_enabled` 开关机制，**先在完整产品上开发模板层（第 2–3 周），发布前再裁剪（第 4 周）**。
3. 定位认知：这是**一次性继承的代码资产**，不是跟着走的上游——裁剪后不再指望 merge 上游更新。

## 五、改造清单

### 保留（核心资产，不动或小改）
| 模块 | 行数 | 用途 |
|---|---|---|
| `features/group_chat/` | 18,000 | 群聊编排全套（总线/名册/路由/任务板） |
| `src/core-agent/` | 57,700 | Agent 运行时 + 多 provider + 记忆 + 技能 |
| `features/agents.ts` + `chats.ts` | 6,300 | Agent 名册（表单创建 + per-agent 模型） |
| `src/main/model/` | — | provider 目录（国产模型齐全） |
| marketplace 骨架 | — | **将来改造成"编队模板市场"的底子** |
| 记忆/资料库 | — | 行业编队的知识底座（FTS5 + 本地向量） |

### 裁剪（第 4 周，发布前）
video_studio 系列（~15 文件）、image_studio/image_gen 系列、web_assist 系列（7 文件）、tts 系列、whisper、office 相关、web_apps 应用生成。预计裁掉 **10–13 万行**，产品收敛到"群聊编队 + 知识库 + 技能"。

### 新写（差异化，第 2–3 周）
1. **编队模板层**（核心工作量）：
   - YAML schema：`team{name, category, description}` + `members[{id, name, provider, model, system_prompt, skills[]}]` + `group_settings` + `acceptance_criteria[]` + `demo_task`
   - **导入器**：读 YAML → 调 agents IPC 批量建 Agent（写 system_prompt + model_override）→ 建群聊会话 → 预置首条任务
   - **导出器**：从现有 Agent + 会话反向生成 YAML
   - 模板库 UI（复用 marketplace 的卡片/安装交互）
2. **首跑引导**：配置模型 Key → 一键导入第一支编队 → 跑通 demo 任务
3. **成本面板**：bus.ts 已有 `conversation-cost-meter`，缺 per-agent/per-task 的 UI 呈现
4. **修两个国内坑**：嵌入模型下载改国内源（HF 镜像或自有 CDN）；文档写明 Electron 镜像设置
5. **换品牌**：⚠️ "Orkas" 名字 + 虎鲸 logo 必须换掉（MIT 只覆盖代码，不覆盖商标与品牌识别）

## 六、修订后的 4 周计划

| 周 | 内容 | 验收 |
|---|---|---|
| **W1 ✓** | 跑通 + 精读 + 本评估 | 已完成 |
| **W2** | **编队模板层**：YAML schema + 导入器/导出器（在完整 Orkas 上开发） | 一支编队 YAML 一键导入成群聊并跑通 |
| **W3** | 3 套演示编队（内容增长/独立开发者销售/竞品调研）+ 成本面板 + 首跑引导；修嵌入模型国内源 | 每套编队产出真实交付物，单任务成本可见 |
| **W4** | 功能裁剪 + 换品牌 + 打包 + 开源发布 + **录第一条视频** | 发布 + 视频发出 |

## 七、风险登记

| 风险 | 等级 | 对策 |
|---|---|---|
| bus.ts 万行大文件，改错牵一发动全身 | 中 | 模板层走 IPC 门面（index.ts），**不直接改 bus.ts**；改动配 smoke 验证 |
| 裁剪后与上游永别，后续 bug 自己扛 | 中 | 已接受此定位；核心是编排层稳定（它有测试兜底） |
| 嵌入模型/Electron 国内下载 | 高（对国内用户） | W3 内修掉；安装文档写镜像配置 |
| 商标/品牌 | 中 | W4 换名换 logo，发布前完成 |
| 33 万行代码的认知负担 | 中 | 遵守"只在门面层动手"纪律；不重构不炫技 |

---

**W1 完成状态：源码跑通 ✓ / 架构精读 ✓ / 改造评估 ✓。下一步进入 W2：编队模板层开发。**
