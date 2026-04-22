// ═══════════════════════════════════════════════════════════════
//  消息格式转换与历史裁剪（对齐 llmcore.py 的 _msgs_claude2oai / _fix_messages / trim_messages_history）
// ═══════════════════════════════════════════════════════════════

import type { ContentBlock, HistoryMsg } from '@shared/types';

/** Claude 格式 → OpenAI 格式 */
export function claudeToOpenAI(messages: HistoryMsg[]): any[] {
  const result: any[] = [];
  for (const msg of messages) {
    const role = msg.role;
    const content = msg.content;
    const blocks: ContentBlock[] = Array.isArray(content)
      ? content
      : [{ type: 'text', text: String(content) }];

    if (role === 'assistant') {
      const textParts: any[] = [];
      const toolCalls: any[] = [];
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text') textParts.push({ type: 'text', text: b.text });
        else if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id,
            type: 'function',
            function: {
              name: b.name,
              arguments: JSON.stringify(b.input ?? {}),
            },
          });
        }
      }
      const m: any = { role: 'assistant' };
      m.content = textParts.length ? textParts : '';
      if (toolCalls.length) m.tool_calls = toolCalls;
      result.push(m);
    } else if (role === 'user') {
      let textParts: any[] = [];
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'tool_result') {
          if (textParts.length) {
            result.push({ role: 'user', content: textParts });
            textParts = [];
          }
          let tr = b.content;
          if (Array.isArray(tr)) {
            tr = tr
              .filter((x: any) => x && x.type === 'text')
              .map((x: any) => x.text || '')
              .join('\n');
          }
          result.push({
            role: 'tool',
            tool_call_id: b.tool_use_id,
            content: typeof tr === 'string' ? tr : String(tr),
          });
        } else if (b.type === 'text') {
          textParts.push({ type: 'text', text: b.text });
        } else if (b.type === 'image') {
          const src: any = b.source || {};
          if (src.type === 'base64' && src.data) {
            textParts.push({
              type: 'image_url',
              image_url: { url: `data:${src.media_type || 'image/png'};base64,${src.data}` },
            });
          }
        }
      }
      if (textParts.length) result.push({ role: 'user', content: textParts });
    } else {
      result.push(msg);
    }
  }
  return result;
}

/** 修复 messages 符合 Claude API 规则：交替、tool_use/tool_result 配对 */
export function fixMessages(messages: HistoryMsg[]): HistoryMsg[] {
  if (!messages.length) return messages;
  const wrap = (c: any): ContentBlock[] =>
    Array.isArray(c) ? c : [{ type: 'text', text: String(c) }];

  const fixed: HistoryMsg[] = [];
  for (let m of messages) {
    if (fixed.length && m.role === fixed[fixed.length - 1].role) {
      const last = fixed[fixed.length - 1];
      fixed[fixed.length - 1] = {
        ...last,
        content: [...wrap(last.content), { type: 'text', text: '\n' }, ...wrap(m.content)],
      };
      continue;
    }
    if (fixed.length && fixed[fixed.length - 1].role === 'assistant' && m.role === 'user') {
      const lastContent = wrap(fixed[fixed.length - 1].content);
      const uses = lastContent
        .filter((b: any) => b.type === 'tool_use')
        .map((b: any) => b.id)
        .filter(Boolean);
      const curContent = wrap(m.content);
      const has = new Set(
        curContent.filter((b: any) => b.type === 'tool_result').map((b: any) => b.tool_use_id),
      );
      const miss = uses.filter((id) => !has.has(id));
      if (miss.length) {
        m = {
          ...m,
          content: [
            ...miss.map<ContentBlock>((id) => ({
              type: 'tool_result',
              tool_use_id: id,
              content: '(error)',
            })),
            ...curContent,
          ],
        };
      }
    }
    fixed.push(m);
  }
  while (fixed.length && fixed[0].role !== 'user') fixed.shift();
  return fixed;
}

/** 粗略估计消息总字符数 */
export function estimateChars(messages: HistoryMsg[]): number {
  return messages.reduce((s, m) => s + JSON.stringify(m).length, 0);
}

/** 历史长度裁剪（context_win * 3 为阈值） */
export function trimHistory(history: HistoryMsg[], contextWin: number): void {
  let cost = estimateChars(history);
  if (cost <= contextWin * 3) return;
  const target = contextWin * 3 * 0.6;
  while (history.length > 5 && cost > target) {
    history.shift();
    while (history.length && history[0].role !== 'user') history.shift();
    // 若首条是 user 且含 tool_result，改写为纯文本避免孤立引用
    if (history[0]?.role === 'user' && Array.isArray(history[0].content)) {
      const texts: string[] = [];
      for (const block of history[0].content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'tool_result') {
          const c = (block as any).content;
          if (Array.isArray(c)) {
            for (const sub of c) if (sub?.type === 'text') texts.push(sub.text);
          } else if (typeof c === 'string') texts.push(c);
        } else if (block.type === 'text') {
          texts.push((block as any).text || '');
        }
      }
      history[0] = {
        ...history[0],
        content: [{ type: 'text', text: texts.filter(Boolean).join('\n') }],
      };
    }
    cost = estimateChars(history);
  }
  console.log(`[Debug] Trimmed context, current: ${cost} chars, ${history.length} messages.`);
}
