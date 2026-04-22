// ═══════════════════════════════════════════════════════════════
//  skill_search 客户端（对齐 memory/skill_search/skill_search/engine.py）
//  从远程 API 根据语义查询相似技能
// ═══════════════════════════════════════════════════════════════

import * as os from 'node:os';

const DEFAULT_API = 'http://www.fudankw.cn:58787';

export interface SkillIndex {
  key: string;
  name?: string;
  description?: string;
  one_line_summary?: string;
  category?: string;
  tags?: string[];
  language?: string;
  os?: string[];
  autonomous_safe?: boolean;
  form?: string;
}

export interface SearchResult {
  skill: SkillIndex;
  relevance: number;
  quality: number;
  final_score: number;
  match_reasons: string[];
  warnings: string[];
}

function detectOS(): string {
  const p = os.platform();
  if (p === 'darwin') return 'macos';
  if (p === 'linux') return 'linux';
  if (p === 'win32') return 'windows';
  return p;
}

function detectShell(): string {
  if (os.platform() === 'win32') return 'powershell';
  const s = process.env.SHELL || '';
  if (s.includes('zsh')) return 'zsh';
  if (s.includes('bash')) return 'bash';
  return 'unknown';
}

export function detectEnvironment() {
  return {
    os: detectOS(),
    shell: detectShell(),
    runtimes: ['node'],
    tools: [] as string[],
    model: { tool_calling: true, reasoning: true, context_window: 'large' },
  };
}

export async function searchSkills(
  query: string,
  opts: { category?: string; topK?: number; apiUrl?: string; apiKey?: string } = {},
): Promise<SearchResult[]> {
  const url = (opts.apiUrl || process.env.SKILL_SEARCH_API || DEFAULT_API).replace(/\/+$/, '');
  const payload: any = {
    query,
    env: detectEnvironment(),
    top_k: opts.topK ?? 10,
  };
  if (opts.category) payload.category = opts.category;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const apiKey = opts.apiKey || process.env.SKILL_SEARCH_KEY;
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const resp = await fetch(`${url}/search`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    throw new Error(`Skill Search API 错误 ${resp.status}: ${await resp.text()}`);
  }
  const body = (await resp.json()) as { results?: SearchResult[] };
  return body.results || [];
}

export async function getSkillStats(apiUrl?: string): Promise<any> {
  const url = (apiUrl || process.env.SKILL_SEARCH_API || DEFAULT_API).replace(/\/+$/, '');
  const resp = await fetch(`${url}/stats`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ env: detectEnvironment() }),
  });
  if (!resp.ok) throw new Error(`stats error ${resp.status}`);
  return resp.json();
}
