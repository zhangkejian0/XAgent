# XAgent


## 核心特性

- **完全 Node.js 实现**：LLM 流式会话、Agent 主循环、工具调度全部用 TypeScript 重写
- **9 个原子工具**：`code_run` · `file_read` · `file_write` · `file_patch` · `web_scan` · `web_execute_js` · `update_working_checkpoint` · `ask_user` · `start_long_term_update`
- **多 LLM 后端**：OpenAI 兼容 / Anthropic 兼容 / Mixin 故障转移
- **L0-L4 四层记忆体系**：对齐 memory 结构
- **skill_search 客户端**：支持从远程技能库语义检索
- **现代聊天 UI**：消息流、工具调用卡片、思考/总结标签高亮、深色主题
- **多会话持久化**：自动保存对话历史到用户数据目录

## 架构

```
XAgent/
├── src/
│   ├── main/                    # Electron 主进程（Node.js 环境）
│   │   ├── main.ts              # 入口 + IPC 路由
│   │   ├── preload.ts           # 安全桥接
│   │   └── core/
│   │       ├── llmcore.ts       # LLM 会话（NativeOAI / NativeClaude / Mixin）
│   │       ├── agentLoop.ts     # Agent 主循环
│   │       ├── sse.ts           # SSE 流解析
│   │       ├── messages.ts      # 消息格式转换
│   │       ├── memory.ts        # L0-L4 记忆系统
│   │       ├── skillSearch.ts   # 远程技能检索
│   │       ├── config.ts        # 设置 & 对话持久化
│   │       └── tools/           # 9 个原子工具
│   ├── renderer/                # React UI
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── MessageBubble.tsx
│   │   │   ├── ToolCallCard.tsx
│   │   │   ├── InputBar.tsx
│   │   │   └── SettingsPanel.tsx
│   │   └── styles.css
│   └── shared/
│       └── types.ts             # 主/渲染进程共享类型
├── assets/
│   ├── tools_schema.json        # 9 工具 Schema
│   ├── sys_prompt.txt           # 系统提示词
│   ├── insight_fixed_structure.txt
│   ├── global_mem_insight_template.txt
│   └── memory_management_sop.md # L0 元 SOP
├── settings.sample.json         # 配置示例
└── package.json
```

## 快速开始

### 安装

```bash
cd XAgent
npm install
```

### 配置 LLM

1. 复制示例配置到用户数据目录（首次启动会自动创建）：
   - Windows: `%APPDATA%/xagent/settings.json`
   - macOS: `~/Library/Application Support/xagent/settings.json`
   - Linux: `~/.config/xagent/settings.json`

2. 或直接启动应用后在 "设置" 面板内配置。

**示例（阿里云通义千问 GLM-5）**：
```json
{
  "llms": [
    {
      "name": "glm-5",
      "type": "native_oai",
      "apikey": "sk-sp-xxxxxxxxxxxx",
      "apibase": "https://coding.dashscope.aliyuncs.com/v1",
      "model": "glm-5"
    }
  ],
  "active_llm": "glm-5"
}
```

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

## LLM 配置详解

### native_oai（OpenAI 兼容）
支持 OpenAI / 阿里通义 / DeepSeek / Moonshot / Minimax 等所有兼容 `/v1/chat/completions` 的接口。

```json
{
  "name": "gpt-5",
  "type": "native_oai",
  "apikey": "sk-...",
  "apibase": "https://api.openai.com/v1",
  "model": "gpt-5.4",
  "reasoning_effort": "high",   
  "temperature": 1,
  "max_tokens": 8192,
  "read_timeout": 120
}
```

### native_claude（Anthropic 兼容）
```json
{
  "name": "claude",
  "type": "native_claude",
  "apikey": "sk-ant-...",
  "apibase": "https://api.anthropic.com",
  "model": "claude-opus-4-6",
  "thinking_type": "adaptive",
  "max_tokens": 32768
}
```

### mixin（故障转移）
```json
{
  "name": "fallback",
  "type": "mixin",
  "apikey": "",
  "apibase": "",
  "model": "",
  "llm_nos": ["glm-5", "gpt-5"],
  "mixin_max_retries": 10,
  "mixin_base_delay": 0.5,
  "mixin_spring_back": 300
}
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


## 许可

MIT
