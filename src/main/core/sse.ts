// ═══════════════════════════════════════════════════════════════
//  SSE 流解析器（对齐 llmcore.py 中的 _parse_claude_sse / _parse_openai_sse）
// ═══════════════════════════════════════════════════════════════

import type { ContentBlock } from '@shared/types';

export interface StreamChunk {
  text?: string;
  /** 流结束时才发出 */
  done?: boolean;
  /** 流结束时带出完整 content_blocks */
  blocks?: ContentBlock[];
  /** 警告/错误 */
  warn?: string;
}

/**
 * 将 Response.body 的流按 SSE 行切分
 */
export async function* iterSSELines(response: Response): AsyncGenerator<string> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line) yield line;
      }
    }
    if (buf) yield buf;
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

/** 解析 Anthropic Messages SSE 流 */
export async function* parseClaudeSSE(response: Response): AsyncGenerator<StreamChunk> {
  const blocks: ContentBlock[] = [];
  let current: any = null;
  let toolJsonBuf = '';
  let stopReason: string | null = null;
  let gotMessageStop = false;
  let warn: string | null = null;

  for await (const line of iterSSELines(response)) {
    if (!line.startsWith('data:')) continue;
    const dataStr = line.slice(5).trimStart();
    if (dataStr === '[DONE]') break;
    let evt: any;
    try { evt = JSON.parse(dataStr); } catch { continue; }
    const evtType = evt.type || '';

    if (evtType === 'message_start') {
      const usage = evt.message?.usage || {};
      console.log(`[Cache] input=${usage.input_tokens || 0} creation=${usage.cache_creation_input_tokens || 0} read=${usage.cache_read_input_tokens || 0}`);
    } else if (evtType === 'content_block_start') {
      const block = evt.content_block || {};
      if (block.type === 'text') current = { type: 'text', text: '' };
      else if (block.type === 'thinking') current = { type: 'thinking', thinking: '' };
      else if (block.type === 'tool_use') {
        current = { type: 'tool_use', id: block.id || '', name: block.name || '', input: {} };
        toolJsonBuf = '';
      }
    } else if (evtType === 'content_block_delta') {
      const delta = evt.delta || {};
      if (delta.type === 'text_delta') {
        const t = delta.text || '';
        if (current?.type === 'text') current.text += t;
        if (t) yield { text: t };
      } else if (delta.type === 'thinking_delta') {
        if (current?.type === 'thinking') current.thinking += (delta.thinking || '');
      } else if (delta.type === 'input_json_delta') {
        toolJsonBuf += delta.partial_json || '';
      }
    } else if (evtType === 'content_block_stop') {
      if (current) {
        if (current.type === 'tool_use') {
          try { current.input = toolJsonBuf ? JSON.parse(toolJsonBuf) : {}; }
          catch { current.input = { _raw: toolJsonBuf }; }
        }
        blocks.push(current);
        current = null;
      }
    } else if (evtType === 'message_delta') {
      stopReason = evt.delta?.stop_reason ?? stopReason;
      const out = evt.usage?.output_tokens || 0;
      if (out) console.log(`[Output] tokens=${out} stop_reason=${stopReason}`);
    } else if (evtType === 'message_stop') {
      gotMessageStop = true;
    } else if (evtType === 'error') {
      const err = evt.error || {};
      const emsg = typeof err === 'object' ? (err.message || JSON.stringify(err)) : String(err);
      warn = `\n\n[SSE Error: ${emsg}]`;
      break;
    }
  }

  if (!warn) {
    if (!gotMessageStop && !stopReason) warn = '\n\n[!!! 流异常中断 !!!]';
    else if (stopReason === 'max_tokens') warn = '\n\n[!!! Response truncated: max_tokens !!!]';
  }
  if (warn) {
    blocks.push({ type: 'text', text: warn });
    yield { text: warn, warn };
  }
  yield { done: true, blocks };
}

/** 解析 OpenAI chat/completions SSE 流 */
export async function* parseOpenAISSE(response: Response): AsyncGenerator<StreamChunk> {
  let contentText = '';
  const tcBuf: Record<number, { id: string; name: string; args: string }> = {};

  for await (const line of iterSSELines(response)) {
    if (!line.startsWith('data:')) continue;
    const dataStr = line.slice(5).trimStart();
    if (dataStr === '[DONE]') break;
    let evt: any;
    try { evt = JSON.parse(dataStr); } catch { continue; }

    const ch = evt.choices?.[0] || {};
    const delta = ch.delta || {};
    if (delta.content) {
      contentText += delta.content;
      yield { text: delta.content };
    }
    for (const tc of (delta.tool_calls || [])) {
      const idx = tc.index ?? 0;
      if (!tcBuf[idx]) tcBuf[idx] = { id: tc.id || '', name: '', args: '' };
      if (tc.function?.name) tcBuf[idx].name = tc.function.name;
      if (tc.function?.arguments) tcBuf[idx].args += tc.function.arguments;
      if (tc.id) tcBuf[idx].id = tc.id;
    }
    const usage = evt.usage;
    if (usage) {
      const cached = usage.prompt_tokens_details?.cached_tokens || 0;
      console.log(`[Cache] input=${usage.prompt_tokens || 0} cached=${cached}`);
    }
  }

  const blocks: ContentBlock[] = [];
  if (contentText) blocks.push({ type: 'text', text: contentText });
  for (const idx of Object.keys(tcBuf).map(Number).sort((a, b) => a - b)) {
    const tc = tcBuf[idx];
    let input: any;
    try { input = tc.args ? JSON.parse(tc.args) : {}; }
    catch { input = { _raw: tc.args }; }
    blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
  }
  yield { done: true, blocks };
}
