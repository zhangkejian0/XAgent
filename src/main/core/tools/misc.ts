// ═══════════════════════════════════════════════════════════════
//  其他工具：update_working_checkpoint / ask_user / start_long_term_update
// ═══════════════════════════════════════════════════════════════

import * as fs from 'node:fs';
import * as path from 'node:path';
import { registerTool, type ToolResult } from './types.js';
import { getMemoryPrompt } from '../memory.js';

// ── update_working_checkpoint ─────────────────────────────
registerTool('update_working_checkpoint', async function* (args, ctx): AsyncGenerator<string, ToolResult> {
  const keyInfo: string | undefined = args.key_info;
  const relatedSop: string | undefined = args.related_sop;
  if (keyInfo !== undefined) ctx.working.key_info = keyInfo;
  if (relatedSop !== undefined) ctx.working.related_sop = relatedSop;
  ctx.working.passed_sessions = 0;
  yield `[Info] Updated key_info and related_sop.\n`;
  return { data: { result: 'working key_info updated' }, nextPrompt: '\n' };
});

// ── ask_user ──────────────────────────────────────────────
registerTool('ask_user', async function* (args, ctx): AsyncGenerator<string, ToolResult> {
  const question: string = args.question || '请提供输入：';
  const candidates: string[] | undefined = args.candidates;
  yield `Waiting for your answer ...\n`;
  const answer = await ctx.askUser(question, candidates);
  return {
    data: {
      status: 'user_answered',
      question,
      answer,
    },
    nextPrompt: `\n[USER ANSWER] ${answer}\n`,
  };
});

// ── start_long_term_update ────────────────────────────────
registerTool('start_long_term_update', async function* (args, ctx): AsyncGenerator<string, ToolResult> {
  yield `[Info] Start distilling good memory for long-term storage.\n`;
  const sopPath = path.join(ctx.memoryDir, 'memory_management_sop.md');
  let sopContent = '';
  if (fs.existsSync(sopPath)) {
    sopContent = fs.readFileSync(sopPath, 'utf-8');
  } else {
    // 回退到 assets 模板
    const tmpl = path.join(__dirname, '..', '..', '..', '..', 'assets', 'memory_management_sop.md');
    if (fs.existsSync(tmpl)) sopContent = fs.readFileSync(tmpl, 'utf-8');
  }

  const prompt = `### [总结提炼经验] 既然你觉得当前任务有重要信息需要记忆，请提取最近一次任务中【事实验证成功且长期有效】的环境事实、用户偏好、重要步骤，更新记忆。
本工具是标记开启结算过程，若已在更新记忆过程或没有值得记忆的点，忽略本次调用。
**提取行动验证成功的信息**：
- **环境事实**（路径/凭证/配置）→ \`file_patch\` 更新 L2，同步 L1
- **复杂任务经验**（关键坑点/前置条件/重要步骤）→ L3 精简 SOP
**禁止**：临时变量、具体推理过程、未验证信息、通用常识。
**操作**：严格遵循 L0 记忆更新 SOP。先 \`file_read\` → 判断类型 → 最小化更新。
${getMemoryPrompt(ctx.cwd, ctx.memoryDir)}`;
  return {
    data: sopContent || 'Memory Management SOP not found. Do not update memory.',
    nextPrompt: prompt,
  };
});

// ── no_tool (隐式工具，模型未调用工具时触发) ──────────────
registerTool('no_tool', async function* (args, ctx): AsyncGenerator<string, ToolResult> {
  const content = ctx.responseContent || '';
  if (!content.trim()) {
    yield `[Warn] LLM returned an empty response. Retrying...\n`;
    return { data: {}, nextPrompt: '[System] Blank response, regenerate and tooluse' };
  }
  if (content.slice(-100).includes('未收到完整响应')) {
    return { data: {}, nextPrompt: '[System] Incomplete response. Regenerate and tooluse.' };
  }
  if (content.slice(-100).includes('max_tokens')) {
    return { data: {}, nextPrompt: '[System] max_tokens limit reached. Use multi small steps.' };
  }

  // 检测"只有一个大代码块且无正文"的情况
  const codeBlockPattern = /```[a-zA-Z0-9_]*\n[\s\S]{50,}?```/g;
  const blocks = [...content.matchAll(codeBlockPattern)];
  if (blocks.length === 1) {
    const block = blocks[0];
    const after = content.slice(block.index! + block[0].length);
    if (!after.trim()) {
      let residual = content.replace(block[0], '');
      residual = residual.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
      residual = residual.replace(/<summary>[\s\S]*?<\/summary>/gi, '');
      const clean = residual.replace(/\s+/g, '');
      if (clean.length <= 30) {
        yield `[Info] Detected large code block without tool call. Requesting clarification.\n`;
        return {
          data: {},
          nextPrompt:
            '[System] 检测到主要内容为较大代码块，但本轮未调用工具。若需执行/写入，请显式调用 code_run / file_write / file_patch；若只是展示，请补充自然语言说明。',
        };
      }
    }
  }

  yield `[Info] Final response to user.\n`;
  // nextPrompt 为 null 意味着结束
  return { data: content, nextPrompt: null };
});
