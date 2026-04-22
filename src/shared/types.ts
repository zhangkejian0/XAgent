// ═══════════════════════════════════════════════════════════════
//  共享类型定义（主进程与渲染进程通用）
// ═══════════════════════════════════════════════════════════════

/** LLM 会话配置 */
export interface LLMConfig {
  /** /llms 显示名 & mixin 引用名 */
  name: string;
  /** API Key */
  apikey: string;
  /** API Base URL */
  apibase: string;
  /** 模型名 */
  model: string;
  /** 类型：native_oai / native_claude / mixin */
  type: 'native_oai' | 'native_claude' | 'mixin';
  /** Mixin 引用的子会话 name 列表（仅 type=mixin 时使用） */
  llm_nos?: string[];
  /** 推理等级 */
  reasoning_effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  /** 思考类型（仅 native_claude） */
  thinking_type?: 'adaptive' | 'enabled' | 'disabled';
  /** 思考预算 */
  thinking_budget_tokens?: number;
  /** 温度 */
  temperature?: number;
  /** 最大输出 token */
  max_tokens?: number;
  /** 流式 */
  stream?: boolean;
  /** 重试次数 */
  max_retries?: number;
  /** 连接超时 */
  connect_timeout?: number;
  /** 读取超时 */
  read_timeout?: number;
  /** 上下文窗口 */
  context_win?: number;
  /** CC 透传渠道需置 true */
  fake_cc_system_prompt?: boolean;
  /** mixin max_retries */
  mixin_max_retries?: number;
  /** mixin base_delay */
  mixin_base_delay?: number;
  /** mixin spring_back */
  mixin_spring_back?: number;
}

/** 全局应用设置 */
export interface AppSettings {
  llms: LLMConfig[];
  /** 当前激活的 llm name */
  active_llm?: string;
  /** 工作目录 */
  cwd?: string;
  /**
   * 记忆目录（L0-L4 记忆的落盘位置）
   *  - 绝对路径：直接使用（例如 D:/proj/XAgent/memory）
   *  - 相对路径：基于 userData 目录
   *  - 未配置：默认 userData/memory
   * 与 cwd 解耦，切换工作目录不会丢失长期记忆。
   */
  memory_dir?: string;
  /** 全局 HTTP 代理 */
  proxy?: string;
  /** UI 语言 */
  lang?: 'zh' | 'en';
  /** 是否记录请求日志 */
  log_requests?: boolean;
  /** 系统提示词覆盖 */
  system_prompt_override?: string;
}

/** Claude 风格消息块 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, any> }
  | { type: 'tool_result'; tool_use_id: string; content: string | ContentBlock[] }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/** 会话历史消息 */
export interface HistoryMsg {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
  tool_results?: { tool_use_id: string; content: string }[];
}

/** 工具调用（模型返回的） */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

/** 工具 schema 条目 */
export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, any>;
      required?: string[];
    };
  };
}

/** 单次工具调用（UI 视图） */
export interface UIToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
  result?: string;
  status: 'pending' | 'running' | 'success' | 'error';
}

/** UI 上展示的一条消息 */
export interface UIMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  /** 文本正文（含 thinking/summary 标签） */
  content: string;
  /** 工具调用 */
  toolCalls?: UIToolCall[];
  /** 时间戳 */
  timestamp: number;
  /** 轮次 */
  turn?: number;
  /** 流式状态 */
  streaming?: boolean;
}

/** 主进程 → 渲染进程的事件 */
export type MainEvent =
  | { type: 'chunk'; text: string; messageId: string }
  | { type: 'tool_call'; messageId: string; call: UIToolCall }
  | { type: 'tool_result'; messageId: string; toolCallId: string; result: string; status: 'success' | 'error' }
  | { type: 'turn_start'; turn: number; messageId: string }
  | { type: 'turn_end'; turn: number }
  | { type: 'task_done'; reason?: string }
  | { type: 'error'; message: string }
  | { type: 'ask_user'; question: string; candidates?: string[] }
  | { type: 'user-msg'; msg: UIMessage };

/** 渲染进程暴露的 API */
export interface XAgentAPI {
  /** 获取设置 */
  getSettings: () => Promise<AppSettings>;
  /** 更新设置 */
  saveSettings: (settings: AppSettings) => Promise<void>;
  /** 发送任务 */
  sendTask: (query: string) => Promise<{ sessionId: string }>;
  /** 中断任务 */
  abortTask: () => Promise<void>;
  /** 切换 LLM */
  switchLLM: (name: string) => Promise<void>;
  /** 列出 LLM */
  listLLMs: () => Promise<{ name: string; type: string; active: boolean }[]>;
  /** 回答 ask_user */
  answerAskUser: (answer: string) => Promise<void>;
  /** 清空历史 */
  clearHistory: () => Promise<void>;
  /** 订阅事件 */
  onEvent: (cb: (e: MainEvent) => void) => () => void;
  /** 获取历史会话列表 */
  listConversations: () => Promise<{ id: string; title: string; updatedAt: number }[]>;
  /** 加载某个历史会话 */
  loadConversation: (id: string) => Promise<UIMessage[]>;
  /** 获取主进程当前激活的会话（用于启动时恢复） */
  getCurrentConversation: () => Promise<{ id: string | null; messages: UIMessage[] }>;
  /** 删除单个历史会话 */
  deleteConversation: (id: string) => Promise<boolean>;
  /** 清空全部历史 */
  deleteAllConversations: () => Promise<number>;
  /** 打开用户数据目录 */
  openUserData: () => void;
  /** 打开开发者工具 */
  openDevTools: () => void;
  /** 重新让窗口获得键盘焦点（原生 confirm/alert 关闭后调用） */
  focusWindow: () => Promise<void>;
}

declare global {
  interface Window {
    xagent: XAgentAPI;
  }
}
