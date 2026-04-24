# XAgent


## 核心特性

- **完全 Node.js 实现**：LLM 流式会话、Agent 主循环、工具调度全部用 TypeScript 重写
- **9 个原子工具**：`code_run` · `file_read` · `file_write` · `file_patch` · `web_scan` · `web_execute_js` · `update_working_checkpoint` · `ask_user` · `start_long_term_update`
- **多 LLM 后端**：OpenAI 兼容 / Anthropic Claude / 本地模型（Ollama/LM Studio/vLLM）/ Mixin 故障转移
- **L0-L4 四层记忆体系**：对齐 memory 结构
- **skill_search 客户端**：支持从远程技能库语义检索
- **技能管理**：浏览、复用、导出 L3 长期记忆（SOP/Utils）为 Anthropic Agent Skills 标准包
- **现代聊天 UI**：消息流、工具调用卡片、思考/总结标签高亮、深色主题、会话历史管理

## 架构

```
XAgent/
├── src/
│   ├── main/                    # Electron 主进程（Node.js 环境）
│   │   ├── main.ts              # 入口 + IPC 路由
│   │   ├── preload.ts           # 安全桥接
│   │   └── core/
│   │       ├── llmcore.ts       # LLM 会话（NativeOAI / NativeClaude / Local / Mixin）
│   │       ├── agentLoop.ts     # Agent 主循环
│   │       ├── sse.ts           # SSE 流解析
│   │       ├── messages.ts      # 消息格式转换
│   │       ├── memory.ts        # L0-L4 记忆系统
│   │       ├── skills.ts        # L3 技能管理（浏览/复用/导出）
│   │       ├── skillSearch.ts   # 远程技能检索
│   │       ├── config.ts        # 设置 & 对话持久化
│   │       └── tools/           # 9 个原子工具
│   ├── renderer/                # React UI
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── MessageBubble.tsx
│   │   │   ├── ToolCallCard.tsx
│   │   │   ├── InputBar.tsx
│   │   │   ├── SettingsPanel.tsx
│   │   │   └── ConfirmDialog.tsx
│   │   └── styles.css
│   └── shared/
│       └── types.ts             # 主/渲染进程共享类型
├── electron/
│   └── dev.js                   # 开发模式 Electron 启动脚本
├── assets/
│   ├── tools_schema.json        # 9 工具 Schema
│   ├── sys_prompt.txt           # 系统提示词
│   ├── insight_fixed_structure.txt
│   ├── global_mem_insight_template.txt
│   └── memory_management_sop.md # L0 元 SOP
└── package.json
```

## 快速开始

### 安装

```bash
cd XAgent
npm install
```

### 配置 LLM

直接启动应用后，点击左下角 **⚙️ 设置** 按钮，在设置面板中配置 LLM：

- **native_oai**：OpenAI 兼容 API（OpenAI / 阿里通义 / DeepSeek / Moonshot 等）
- **native_claude**：Anthropic Claude API
- **local**：本地模型（Ollama / LM Studio / vLLM 等，无需 API Key）
- **mixin**：故障转移组合多个 LLM

首次启动会自动创建空配置，在设置面板添加 LLM 后保存即可使用。

### 开发模式

一条命令同时启动 Vite 渲染层 + TS 主进程 watch 编译 + Electron（Electron 会等 Vite 和编译产物就绪后自动启动）：

```bash
npm run dev
```

### 生产模式

```bash
npm run build
npm start
```

### 打包

```bash
npm run build
npm run package
```

## 工具清单

| 工具 | 说明 |
|:-|:-|
| `code_run` | 执行 python / node / powershell / bash 脚本 |
| `file_read` | 读取文件（带行号/关键字定位/自动截断） |
| `file_write` | 创建 / 覆盖 / 追加 / 前置写入文件 |
| `file_patch` | 精细局部修改（唯一匹配替换） |
| `web_scan` | 打开/扫描网页（基于 Electron BrowserWindow） |
| `web_execute_js` | 在浏览器中执行 JS |
| `update_working_checkpoint` | 更新短期工作便签 |
| `ask_user` | 中断任务向用户提问 |
| `start_long_term_update` | 触发长期记忆结算流程 |

## 记忆系统

- **L1 Insight** (`<cwd>/memory/global_mem_insight.txt`)：极简索引，每轮注入 system prompt
- **L2 Facts** (`<cwd>/memory/global_mem.txt`)：长期环境事实
- **L3 SOPs** (`<cwd>/memory/*.md / *.py`)：复杂任务经验
- **L4 Raw** (`<cwd>/memory/L4_raw_sessions/`)：原始会话存档

## 快捷键

- `Enter` 发送
- `Shift + Enter` 换行
- 任务进行中点击发送按钮变为 **停止** 按钮可中断

## 更新日志

### v0.1.3

- **技能管理**：新增技能管理模块，支持浏览、复用和导出 L3 长期记忆（SOP/Utils）
  - **技能列表**：设置面板新增"🧠 技能管理"Tab，自动扫描 memory 目录下的 `*.md` / `*.py` 文件
  - **复用技能**：一键复用已有技能，自动新建会话并由 LLM 读取并讲解如何使用（前置条件、关键步骤、避坑指南）
  - **导出技能**：支持导出为 Anthropic Agent Skills 标准目录包（含 `SKILL.md` + `scripts/`），可直接安装到 Claude/Cursor Skills
  - **访问统计**：自动追踪技能文件读取次数，按热度排序展示
- **代码重构**：抽取 `runTaskInternal` 统一处理任务启动逻辑，支持 `task:send` / `memory:trigger` / `skills:reuse` 复用

### v0.1.1

- **文件管理**：新增 FileManager 模块，自动扫描工作目录并分类管理文件（文档、表格、图片等）
- **文件管理面板**：设置面板添加文件管理 Tab，按分类展示文件列表
- **记忆触发按钮**：输入栏添加触发记忆按钮，对话完成后可手动触发长期记忆更新
- **file_write 增强**：支持 `category` 参数，自动路由文件到 `.xagent` 子目录

### v0.1.0

- 初始化 XAgent 桌面智能体项目
- 9 个原子工具实现
- 多 LLM 后端支持（OpenAI/Claude/本地模型/Mixin 故障转移）
- L0-L4 四层记忆体系
- 现代聊天 UI

## 许可

MIT
