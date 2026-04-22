// ═══════════════════════════════════════════════════════════════
//  Agent 主循环（对齐 Python agent_loop.agent_runner_loop）
//  流程：system+user → LLM.ask → 解析 tool_use → dispatch 工具 → 组装 next_prompt → 下一轮
// ═══════════════════════════════════════════════════════════════

import type { ContentBlock, HistoryMsg, ToolSchema, UIToolCall } from '@shared/types';
import type { LLMSession } from './llmcore.js';
import { toolRegistry, type ToolContext } from './tools/index.js';
import { getMemoryPrompt } from './memory.js';

export interface RunOptions {
  session: LLMSession;
  userInput: string;
  systemPrompt: string;
  tools: ToolSchema[];
  ctx: ToolContext;
  maxTurns?: number;
  /** 发射 UI 事件 */
  emit: (evt: AgentEvent) => void;
}

export type AgentEvent =
  | { type: 'turn_start'; turn: number; messageId: string }
  | { type: 'chunk'; text: string; messageId: string }
  | { type: 'tool_call'; messageId: string; call: UIToolCall }
  | { type: 'tool_result'; messageId: string; toolCallId: string; result: string; status: 'success' | 'error' }
  | { type: 'tool_stream'; messageId: string; toolCallId: string; text: string }
  | { type: 'turn_end'; turn: number }
  | { type: 'task_done'; reason?: string; data?: any }
  | { type: 'error'; message: string }
  | { type: 'ask_user'; question: string; candidates?: string[] };

function makeId(prefix = 'msg'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildAnchorPrompt(ctx: ToolContext): string {
  const h = ctx.historyInfo.slice(-20).join('\n');
  let prompt = `\n### [WORKING MEMORY]\n<history>\n${h}\n</history>`;
  prompt += `\nCurrent turn: ${ctx.currentTurn}\n`;
  if (ctx.working.key_info) prompt += `\n<key_info>${ctx.working.key_info}</key_info>`;
  if (ctx.working.related_sop)
    prompt += `\n有不清晰的地方请再次读取 ${ctx.working.related_sop}`;
  return prompt;
}

/** 从 assistant 的 content_blocks 中提取 text + tool_use */
function parseAssistantBlocks(blocks: ContentBlock[]): {
  textContent: string;
  toolCalls: { id: string; name: string; args: Record<string, any> }[];
} {
  let textContent = '';
  const toolCalls: { id: string; name: string; args: Record<string, any> }[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text') textContent += b.text;
    else if (b.type === 'tool_use') {
      toolCalls.push({ id: b.id, name: b.name, args: b.input || {} });
    }
  }
  return { textContent, toolCalls };
}

/** 主循环 */
export async function runAgentLoop(opts: RunOptions): Promise<{ result: string; reason: string }> {
  const { session, userInput, systemPrompt, tools, ctx, emit } = opts;
  const maxTurns = opts.maxTurns ?? 40;

  session.system = systemPrompt;
  session.tools = tools;

  // 首轮 user 消息
  let nextUserMsg: HistoryMsg = {
    role: 'user',
    content: [{ type: 'text', text: userInput }],
  };

  let turn = 0;
  let exitReason: { result: string; data?: any } | null = null;

  while (turn < maxTurns) {
    if (ctx.stopSignal.aborted) {
      exitReason = { result: 'ABORTED' };
      break;
    }
    turn += 1;
    ctx.currentTurn = turn;

    const messageId = makeId('asst');
    emit({ type: 'turn_start', turn, messageId });

    // 发起一轮 LLM 调用
    const gen = session.ask(nextUserMsg, { tools });
    let result: { blocks: ContentBlock[] } = { blocks: [] };
    try {
      while (true) {
        const n = await gen.next();
        if (n.done) {
          result = n.value;
          break;
        }
        emit({ type: 'chunk', text: n.value, messageId });
      }
    } catch (e: any) {
      emit({ type: 'error', message: String(e?.message || e) });
      exitReason = { result: 'LLM_ERROR' };
      break;
    }

    const { textContent, toolCalls } = parseAssistantBlocks(result.blocks);
    ctx.responseContent = textContent;

    // 如果没有 tool_call，触发 no_tool
    const effectiveCalls =
      toolCalls.length > 0
        ? toolCalls
        : [{ id: makeId('tc'), name: 'no_tool', args: {} }];

    const toolResults: { tool_use_id: string; content: string }[] = [];
    const nextPrompts = new Set<string>();
    let doneReason: { result: string; data?: any } | null = null;

    for (let ii = 0; ii < effectiveCalls.length; ii++) {
      const tc = effectiveCalls[ii];
      const tid = tc.id;

      if (tc.name !== 'no_tool') {
        emit({
          type: 'tool_call',
          messageId,
          call: {
            id: tid,
            name: tc.name,
            args: tc.args,
            status: 'running',
          },
        });
      }

      const handler = toolRegistry[tc.name];
      if (!handler) {
        toolResults.push({
          tool_use_id: tid,
          content: JSON.stringify({ status: 'error', msg: `未知工具: ${tc.name}` }),
        });
        emit({
          type: 'tool_result',
          messageId,
          toolCallId: tid,
          result: `未知工具: ${tc.name}`,
          status: 'error',
        });
        nextPrompts.add(`[System] 未知工具 ${tc.name}`);
        continue;
      }

      // 执行工具
      let outcome: any = null;
      try {
        const g = handler(tc.args, ctx);
        while (true) {
          const n = await g.next();
          if (n.done) {
            outcome = n.value;
            break;
          }
          emit({ type: 'tool_stream', messageId, toolCallId: tid, text: n.value });
        }
      } catch (e: any) {
        emit({
          type: 'tool_result',
          messageId,
          toolCallId: tid,
          result: String(e?.message || e),
          status: 'error',
        });
        toolResults.push({
          tool_use_id: tid,
          content: JSON.stringify({ status: 'error', msg: String(e?.message || e) }),
        });
        continue;
      }

      if (!outcome) continue;
      const resultStr =
        typeof outcome.data === 'string'
          ? outcome.data
          : JSON.stringify(outcome.data, null, 2);

      if (tc.name !== 'no_tool') {
        emit({
          type: 'tool_result',
          messageId,
          toolCallId: tid,
          result: resultStr,
          status: 'success',
        });
        toolResults.push({ tool_use_id: tid, content: resultStr });
      }

      if (outcome.shouldExit) {
        doneReason = { result: 'EXITED', data: outcome.data };
        break;
      }
      if (outcome.nextPrompt === null || outcome.nextPrompt === undefined) {
        doneReason = { result: 'CURRENT_TASK_DONE', data: outcome.data };
        break;
      }
      nextPrompts.add(outcome.nextPrompt);
    }

    // 回调：总结历史，记录到 historyInfo
    const summaryMatch = textContent.match(/<summary>([\s\S]*?)<\/summary>/);
    let summary = summaryMatch?.[1]?.trim();
    if (!summary) {
      const tc = effectiveCalls[0];
      summary =
        tc.name === 'no_tool'
          ? '直接回答了用户问题'
          : `调用 ${tc.name}(${JSON.stringify(tc.args).slice(0, 60)})`;
    }
    if (summary.length > 100) summary = summary.slice(0, 50) + '...' + summary.slice(-50);
    ctx.historyInfo.push(`[Agent] ${summary}`);

    emit({ type: 'turn_end', turn });

    if (doneReason) {
      exitReason = doneReason;
      break;
    }

    // 组装 next_prompt
    let np = [...nextPrompts].join('\n');
    if (!summaryMatch && effectiveCalls[0].name !== 'no_tool') {
      np += '\n[DANGER] 上一轮遗漏了 <summary>，请在下次回复中补充。';
    }
    // 注入 anchor prompt（working memory）
    np += buildAnchorPrompt(ctx);
    if (turn % 7 === 0) {
      np += `\n\n[DANGER] 已连续执行第 ${turn} 轮。禁止无效重试，必要时 ask_user。`;
    }
    if (turn % 10 === 0) {
      np += getMemoryPrompt(ctx.cwd, ctx.memoryDir);
    }

    nextUserMsg = {
      role: 'user',
      content: [{ type: 'text', text: np }],
      tool_results: toolResults,
    } as HistoryMsg;

    // 注意：session.ask 会 append 这条 user msg，其中 tool_results 会在 _msgs_claude2oai 转成 tool role 消息
    // 为兼容 native_claude：把 tool_results 直接并入 content
    if (toolResults.length) {
      const mergedBlocks: ContentBlock[] = [
        ...toolResults.map<ContentBlock>((tr) => ({
          type: 'tool_result',
          tool_use_id: tr.tool_use_id,
          content: tr.content,
        })),
        { type: 'text', text: np },
      ];
      nextUserMsg = { role: 'user', content: mergedBlocks };
    }
  }

  const reason = exitReason?.result || 'MAX_TURNS_EXCEEDED';
  emit({ type: 'task_done', reason, data: (exitReason as any)?.data });
  return {
    result: typeof exitReason?.data === 'string' ? exitReason.data : JSON.stringify(exitReason?.data || {}),
    reason,
  };
}
