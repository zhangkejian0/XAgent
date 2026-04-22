// ═══════════════════════════════════════════════════════════════
//  LLM 会话核心（对齐 llmcore.py）
//  - NativeOAISession : OpenAI chat/completions + 原生 tool_calls
//  - NativeClaudeSession : Anthropic Messages + 原生 tool_use
//  - MixinSession : 多 session 故障转移
// ═══════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import type { ContentBlock, HistoryMsg, LLMConfig, ToolSchema } from '@shared/types';
import { claudeToOpenAI, fixMessages, trimHistory } from './messages.js';
import { parseClaudeSSE, parseOpenAISSE, StreamChunk } from './sse.js';

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

function autoMakeUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  const p = path.replace(/^\/+/, '').replace(/\/+$/, '');
  if (b.endsWith('$')) return b.slice(0, -1).replace(/\/+$/, '');
  if (b.endsWith(p)) return b;
  return /\/v\d+(\/|$)/.test(b) ? `${b}/${p}` : `${b}/v1/${p}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Claude 模型的 cache_control 标记 */
function stampOAICacheMarkers(messages: any[], model: string): void {
  const ml = model.toLowerCase();
  if (!['claude', 'anthropic'].some((k) => ml.includes(k))) return;
  const userIdxs = messages
    .map((m, i) => (m.role === 'user' ? i : -1))
    .filter((i) => i >= 0);
  for (const idx of userIdxs.slice(-2)) {
    const c = messages[idx].content;
    if (typeof c === 'string') {
      messages[idx] = {
        ...messages[idx],
        content: [{ type: 'text', text: c, cache_control: { type: 'ephemeral' } }],
      };
    } else if (Array.isArray(c) && c.length) {
      const cc = [...c];
      cc[cc.length - 1] = { ...cc[cc.length - 1], cache_control: { type: 'ephemeral' } };
      messages[idx] = { ...messages[idx], content: cc };
    }
  }
}

function openaiToolsToClaude(tools: ToolSchema[]): any[] {
  return tools.map((t) => {
    if ((t as any).input_schema) return t;
    const fn = t.function;
    return {
      name: fn.name,
      description: fn.description || '',
      input_schema: fn.parameters || { type: 'object', properties: {} },
    };
  });
}

// ═══════════════════════════════════════════════════════════════
//  Session 抽象基类
// ═══════════════════════════════════════════════════════════════

export interface ChatOptions {
  tools?: ToolSchema[];
  abortSignal?: AbortSignal;
}

export interface ChatResult {
  blocks: ContentBlock[];
}

export interface LLMSession {
  name: string;
  model: string;
  history: HistoryMsg[];
  system: string;
  tools: ToolSchema[] | null;
  /** 用户追问 */
  ask(msg: HistoryMsg, opts?: ChatOptions): AsyncGenerator<string, ChatResult>;
  /** 清空历史 */
  clearHistory(): void;
  /** 设置/修改会话属性 */
  setProp<K extends keyof this>(key: K, value: this[K]): void;
}

abstract class BaseSession implements LLMSession {
  readonly name: string;
  readonly model: string;
  readonly cfg: LLMConfig;
  history: HistoryMsg[] = [];
  system: string = '';
  tools: ToolSchema[] | null = null;
  contextWin: number;
  maxRetries: number;
  connectTimeout: number;
  readTimeout: number;
  temperature: number;
  maxTokens: number;
  stream: boolean;
  reasoningEffort?: string;

  constructor(cfg: LLMConfig, defaultContextWin = 24000) {
    this.cfg = cfg;
    this.name = cfg.name || cfg.model || 'unnamed';
    this.model = cfg.model;
    this.contextWin = cfg.context_win ?? defaultContextWin;
    this.maxRetries = Math.max(0, cfg.max_retries ?? 1);
    this.connectTimeout = Math.max(1, cfg.connect_timeout ?? 10);
    this.readTimeout = Math.max(5, cfg.read_timeout ?? 60);
    this.temperature = cfg.temperature ?? 1;
    this.maxTokens = cfg.max_tokens ?? 8192;
    this.stream = cfg.stream ?? true;
    this.reasoningEffort = cfg.reasoning_effort;
  }

  clearHistory() {
    this.history = [];
  }

  setProp<K extends keyof this>(key: K, value: this[K]) {
    this[key] = value;
  }

  abstract rawAsk(messages: HistoryMsg[], opts?: ChatOptions): AsyncGenerator<string, ChatResult>;

  async *ask(msg: HistoryMsg, opts?: ChatOptions): AsyncGenerator<string, ChatResult> {
    this.history.push(msg);
    trimHistory(this.history, this.contextWin);
    const messages = this.history.map((m) => ({
      ...m,
      content: Array.isArray(m.content) ? [...m.content] : m.content,
    }));
    const gen = this.rawAsk(messages, opts);
    let result: ChatResult = { blocks: [] };
    try {
      while (true) {
        const n = await gen.next();
        if (n.done) {
          result = n.value;
          break;
        }
        yield n.value;
      }
    } catch (e: any) {
      const err = `Error: ${e?.message || e}`;
      yield err;
      result = { blocks: [{ type: 'text', text: err }] };
    }
    const blocks = result.blocks || [];
    const isErr =
      blocks.length === 1 &&
      blocks[0].type === 'text' &&
      (blocks[0].text.startsWith('Error:') || blocks[0].text.startsWith('[Error:'));
    if (blocks.length && !isErr) {
      this.history.push({ role: 'assistant', content: blocks });
    }
    return result;
  }
}

// ═══════════════════════════════════════════════════════════════
//  NativeOAISession — OpenAI chat/completions + 原生 function calling
// ═══════════════════════════════════════════════════════════════

export class NativeOAISession extends BaseSession {
  async *rawAsk(
    messages: HistoryMsg[],
    opts?: ChatOptions,
  ): AsyncGenerator<string, ChatResult> {
    const tools = opts?.tools ?? this.tools;
    const sysMsgs: any[] = this.system ? [{ role: 'system', content: this.system }] : [];
    const msgs = [...sysMsgs, ...claudeToOpenAI(messages)];
    stampOAICacheMarkers(msgs, this.model);

    const ml = this.model.toLowerCase();
    let temp = this.temperature;
    if (ml.includes('kimi') || ml.includes('moonshot')) temp = 1;
    else if (ml.includes('minimax')) temp = Math.max(0.01, Math.min(temp, 1));

    const url = autoMakeUrl(this.cfg.apibase, 'chat/completions');
    const payload: any = {
      model: this.model,
      messages: msgs,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (temp !== 1) payload.temperature = temp;
    if (this.maxTokens) payload.max_tokens = this.maxTokens;
    if (this.reasoningEffort) payload.reasoning_effort = this.reasoningEffort;
    if (tools?.length) payload.tools = tools;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };
    // 本地模型不需要 Authorization，apikey 为空时不设置
    if (this.cfg.apikey && this.cfg.apikey.trim()) {
      headers['Authorization'] = `Bearer ${this.cfg.apikey}`;
    }

    return yield* streamWithRetry(url, headers, payload, parseOpenAISSE, {
      maxRetries: this.maxRetries,
      abortSignal: opts?.abortSignal,
    });
  }
}

// ═══════════════════════════════════════════════════════════════
//  NativeClaudeSession — Anthropic Messages + 原生 tool_use
// ═══════════════════════════════════════════════════════════════

export class NativeClaudeSession extends BaseSession {
  fakeCcSystem: boolean;
  thinkingType?: 'adaptive' | 'enabled' | 'disabled';
  thinkingBudgetTokens?: number;
  private deviceId = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 32);
  private accountUuid = randomUUID();
  private sessionId = randomUUID();

  constructor(cfg: LLMConfig) {
    super(cfg, 28000);
    this.fakeCcSystem = cfg.fake_cc_system_prompt ?? false;
    this.thinkingType = cfg.thinking_type;
    this.thinkingBudgetTokens = cfg.thinking_budget_tokens;
  }

  async *rawAsk(
    messagesIn: HistoryMsg[],
    opts?: ChatOptions,
  ): AsyncGenerator<string, ChatResult> {
    const tools = opts?.tools ?? this.tools;
    let messages = fixMessages(messagesIn);
    let model = this.model;
    const betaParts = [
      'claude-code-20250219',
      'interleaved-thinking-2025-05-14',
      'redact-thinking-2026-02-12',
      'prompt-caching-scope-2026-01-05',
    ];
    if (model.toLowerCase().includes('[1m]')) {
      betaParts.splice(1, 0, 'context-1m-2025-08-07');
      model = model.replace(/\[1m\]/gi, '');
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': betaParts.join(','),
      'anthropic-dangerous-direct-browser-access': 'true',
      'user-agent': 'claude-cli/2.1.90 (external, cli)',
      'x-app': 'cli',
    };
    if (this.cfg.apikey.startsWith('sk-ant-')) headers['x-api-key'] = this.cfg.apikey;
    else headers['authorization'] = `Bearer ${this.cfg.apikey}`;

    const payload: any = {
      model,
      messages,
      max_tokens: this.maxTokens,
      stream: this.stream,
    };
    if (this.temperature !== 1) payload.temperature = this.temperature;

    // thinking
    if (this.thinkingType) {
      const t: any = { type: this.thinkingType };
      if (this.thinkingType === 'enabled') {
        if (this.thinkingBudgetTokens !== undefined) {
          t.budget_tokens = this.thinkingBudgetTokens;
          payload.thinking = t;
        }
      } else payload.thinking = t;
    }
    if (this.reasoningEffort) {
      const map: Record<string, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'max' };
      const effort = map[this.reasoningEffort];
      if (effort) payload.output_config = { effort };
    }

    payload.metadata = {
      user_id: JSON.stringify({
        device_id: this.deviceId,
        account_uuid: this.accountUuid,
        session_id: this.sessionId,
      }),
    };

    if (tools?.length) {
      const claudeTools = openaiToolsToClaude(tools);
      const tt = claudeTools.map((t) => ({ ...t }));
      tt[tt.length - 1].cache_control = { type: 'ephemeral' };
      payload.tools = tt;
    }

    // system
    payload.system = [
      {
        type: 'text',
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
        cache_control: { type: 'ephemeral' },
      },
    ];
    if (this.system) {
      if (this.fakeCcSystem) {
        if (messages[0]?.role === 'user') {
          const content = Array.isArray(messages[0].content) ? [...messages[0].content] : [];
          content.unshift({ type: 'text', text: this.system });
          messages = [{ ...messages[0], content }, ...messages.slice(1)];
          payload.messages = messages;
        }
      } else {
        payload.system = [{ type: 'text', text: this.system }];
      }
    }

    // user 最后两条打 cache_control
    const userIdxs = messages
      .map((m, i) => (m.role === 'user' ? i : -1))
      .filter((i) => i >= 0);
    for (const idx of userIdxs.slice(-2)) {
      const content = Array.isArray(messages[idx].content) ? [...messages[idx].content] : [];
      if (content.length) {
        content[content.length - 1] = {
          ...(content[content.length - 1] as any),
          cache_control: { type: 'ephemeral' },
        };
        messages[idx] = { ...messages[idx], content };
      }
    }
    payload.messages = messages;

    const url = autoMakeUrl(this.cfg.apibase, 'messages') + '?beta=true';

    return yield* streamWithRetry(url, headers, payload, parseClaudeSSE, {
      maxRetries: this.maxRetries,
      abortSignal: opts?.abortSignal,
    });
  }
}

// ═══════════════════════════════════════════════════════════════
//  流式请求 + 重试
// ═══════════════════════════════════════════════════════════════

async function* streamWithRetry(
  url: string,
  headers: Record<string, string>,
  payload: any,
  parser: (r: Response) => AsyncGenerator<StreamChunk>,
  opts: { maxRetries: number; abortSignal?: AbortSignal },
): AsyncGenerator<string, ChatResult> {
  const { maxRetries, abortSignal } = opts;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let streamed = false;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: abortSignal,
      });
      if (!resp.ok) {
        let errBody = '';
        try { errBody = (await resp.text()).slice(0, 1200); } catch { /* ignore */ }
        if (RETRYABLE_STATUS.has(resp.status) && attempt < maxRetries) {
          const ra = parseFloat(resp.headers.get('retry-after') || '');
          const d = Math.max(0.5, isFinite(ra) ? ra : Math.min(30, 1.5 * 2 ** attempt)) * 1000;
          console.log(`[LLM Retry] HTTP ${resp.status}, retry in ${d / 1000}s (${attempt + 1}/${maxRetries + 1})`);
          await sleep(d);
          continue;
        }
        const err = `Error: HTTP ${resp.status}; body: ${errBody || '<empty>'}`;
        yield err;
        return { blocks: [{ type: 'text', text: err }] };
      }
      const gen = parser(resp);
      let blocks: ContentBlock[] = [];
      while (true) {
        const n = await gen.next();
        if (n.done) break;
        if (n.value.done) {
          blocks = n.value.blocks || [];
          break;
        }
        if (n.value.text) {
          streamed = true;
          yield n.value.text;
        }
      }
      return { blocks };
    } catch (e: any) {
      if (abortSignal?.aborted) {
        yield '[Aborted]';
        return { blocks: [{ type: 'text', text: '[Aborted]' }] };
      }
      if (attempt < maxRetries && !streamed) {
        const d = Math.min(30, 1.5 * 2 ** attempt) * 1000;
        console.log(`[LLM Retry] ${e?.name || 'Error'}, retry in ${d / 1000}s (${attempt + 1}/${maxRetries + 1})`);
        await sleep(d);
        continue;
      }
      const err = `Error: ${e?.message || e}`;
      yield err;
      return { blocks: [{ type: 'text', text: err }] };
    }
  }
  return { blocks: [] };
}

// ═══════════════════════════════════════════════════════════════
//  MixinSession — 多 session 故障转移
// ═══════════════════════════════════════════════════════════════

export class MixinSession implements LLMSession {
  readonly name: string;
  readonly model: string;
  readonly sessions: BaseSession[];
  private retries: number;
  private baseDelay: number;
  private springSec: number;
  private curIdx = 0;
  private switchedAt = 0;

  constructor(allSessions: BaseSession[], cfg: LLMConfig) {
    const refs = cfg.llm_nos || [];
    this.sessions = refs.map((ref) => {
      if (typeof ref === 'number') return allSessions[ref];
      const found = allSessions.find((s) => s.name === ref);
      if (!found) throw new Error(`MixinSession: session '${ref}' not found`);
      return found;
    });
    const groups = new Set(this.sessions.map((s) => s instanceof NativeClaudeSession));
    if (groups.size > 1) {
      throw new Error('MixinSession: sessions must all be Native-Claude or all Native-OAI');
    }
    this.name = this.sessions.map((s) => s.name).join('|');
    this.model = this.sessions[0]?.model || '';
    this.retries = cfg.mixin_max_retries ?? 3;
    this.baseDelay = cfg.mixin_base_delay ?? 1.5;
    this.springSec = cfg.mixin_spring_back ?? 300;
  }

  get history(): HistoryMsg[] {
    return this.sessions[0].history;
  }
  set history(v: HistoryMsg[]) {
    this.sessions[0].history = v;
  }
  get system(): string {
    return this.sessions[0].system;
  }
  set system(v: string) {
    for (const s of this.sessions) s.system = v;
  }
  get tools(): ToolSchema[] | null {
    return this.sessions[0].tools;
  }
  set tools(v: ToolSchema[] | null) {
    for (const s of this.sessions) s.tools = v;
  }

  clearHistory() {
    for (const s of this.sessions) s.clearHistory();
  }

  setProp<K extends keyof this>(key: K, value: this[K]) {
    this[key] = value;
  }

  private pickIdx(): number {
    if (this.curIdx && Date.now() / 1000 - this.switchedAt > this.springSec) {
      this.curIdx = 0;
    }
    return this.curIdx;
  }

  async *ask(msg: HistoryMsg, opts?: ChatOptions): AsyncGenerator<string, ChatResult> {
    // 历史只记在第一个 session，其它转发前拷贝
    this.sessions[0].history.push(msg);
    trimHistory(this.sessions[0].history, this.sessions[0].contextWin);
    const snapshot = this.sessions[0].history.map((m) => ({
      ...m,
      content: Array.isArray(m.content) ? [...m.content] : m.content,
    }));
    // 去掉刚 push 的，因为每次 session.rawAsk 都要拿到最新历史
    this.sessions[0].history.pop();

    const base = this.pickIdx();
    const n = this.sessions.length;
    const isErr = (t: string) => t.startsWith('Error:') || t.startsWith('[Error:');

    let result: ChatResult = { blocks: [] };
    let yielded = false;
    let lastChunk = '';
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const idx = (base + attempt) % n;
      const s = this.sessions[idx];
      console.log(`[MixinSession] Using session (${s.name})`);
      // 同步历史
      s.history = [...snapshot];
      const gen = s.rawAsk(snapshot, opts);
      try {
        while (true) {
          const nn = await gen.next();
          if (nn.done) {
            result = nn.value;
            break;
          }
          lastChunk = nn.value;
          if (!yielded && isErr(lastChunk)) continue;
          yielded = true;
          yield nn.value;
        }
      } catch (e: any) {
        lastChunk = `Error: ${e?.message || e}`;
      }
      const isError = isErr(lastChunk);
      if (!isError) {
        if (attempt > 0) {
          this.curIdx = idx;
          this.switchedAt = Date.now() / 1000;
        }
        // 同步回主 session
        this.sessions[0].history = s.history;
        return result;
      }
      if (attempt >= this.retries) {
        yield lastChunk;
        return result;
      }
      const nxt = (base + attempt + 1) % n;
      if (nxt === base) {
        const round = Math.floor((attempt + 1) / n);
        const delay = Math.min(30, this.baseDelay * 1.5 ** round) * 1000;
        console.log(`[MixinSession] round ${round} exhausted, retry in ${delay / 1000}s`);
        await sleep(delay);
      } else {
        console.log(`[MixinSession] retry ${attempt + 1}/${this.retries} (s${idx}→s${nxt})`);
      }
    }
    return result;
  }
}

// ═══════════════════════════════════════════════════════════════
//  工厂函数
// ═══════════════════════════════════════════════════════════════

export function buildSessions(configs: LLMConfig[]): Map<string, LLMSession> {
  const sessions = new Map<string, LLMSession>();
  const bases: BaseSession[] = [];
  for (const cfg of configs) {
    if (cfg.type === 'native_claude') {
      const s = new NativeClaudeSession(cfg);
      sessions.set(s.name, s);
      bases.push(s);
    } else if (cfg.type === 'native_oai' || cfg.type === 'local') {
      // local 类型使用 OpenAI 兼容 API，但不需要 API Key
      const s = new NativeOAISession(cfg);
      sessions.set(s.name, s);
      bases.push(s);
    }
  }
  // 之后再创建 mixin
  for (const cfg of configs) {
    if (cfg.type === 'mixin') {
      try {
        const mix = new MixinSession(bases, cfg);
        sessions.set(cfg.name, mix);
      } catch (e: any) {
        console.error(`[WARN] Failed to init MixinSession ${cfg.name}: ${e?.message}`);
      }
    }
  }
  return sessions;
}
