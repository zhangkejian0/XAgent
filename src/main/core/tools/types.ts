import type { AppSettings } from '@shared/types';

/** 工具执行上下文 */
export interface ToolContext {
  /** 当前工作目录（绝对路径） */
  cwd: string;
  /** 记忆目录（绝对路径，独立于 cwd） */
  memoryDir: string;
  /** 工作便签（短期记忆） */
  working: Record<string, any>;
  /** 当前轮次 */
  currentTurn: number;
  /** 历史摘要（注入 anchor prompt） */
  historyInfo: string[];
  /** 应用设置 */
  settings: AppSettings;
  /** 停止信号 */
  stopSignal: { aborted: boolean };
  /** 发送事件回调（UI 更新） */
  emit(event: string, payload: any): void;
  /** 询问用户（阻塞式）*/
  askUser(question: string, candidates?: string[]): Promise<string>;
  /** 提取回复正文中的代码块 */
  responseContent: string;
}

/** 工具执行结果 */
export interface ToolResult {
  /** 结果数据（会转成 tool_result 内容传回模型） */
  data: any;
  /** 下一轮的 next_prompt 追加内容（null 表示结束任务） */
  nextPrompt?: string | null;
  /** 是否退出 agent 循环 */
  shouldExit?: boolean;
  /** 流式输出（UI 展示用） */
  stream?: string[];
}

export type ToolHandler = (
  args: Record<string, any>,
  ctx: ToolContext,
) => AsyncGenerator<string, ToolResult>;

/** 聚合工具表 */
export const toolRegistry: Record<string, ToolHandler> = {};

export function registerTool(name: string, handler: ToolHandler): void {
  toolRegistry[name] = handler;
}
