// ═══════════════════════════════════════════════════════════════
//  文件操作工具：file_read / file_write / file_patch
//  对齐 ga.py 里的同名实现
// ═══════════════════════════════════════════════════════════════

import * as fs from 'node:fs';
import * as path from 'node:path';
import { registerTool, type ToolContext, type ToolResult } from './types.js';
import type { FileCategory } from '../fileManager.js';

function resolvePath(ctx: ToolContext, p: string): string {
  if (!p) return ctx.cwd;
  return path.isAbsolute(p) ? p : path.resolve(ctx.cwd, p);
}

function smartFormat(s: string, maxLen = 100, omit = ' ... '): string {
  if (s.length < maxLen + omit.length * 2) return s;
  const half = Math.floor(maxLen / 2);
  return s.slice(0, half) + omit + s.slice(-half);
}

/** 展开 {{file:path:start:end}} 引用 */
function expandFileRefs(text: string, baseDir: string): string {
  const pat = /\{\{file:(.+?):(\d+):(\d+)\}\}/g;
  return text.replace(pat, (_m, p, s, e) => {
    const start = parseInt(s, 10);
    const end = parseInt(e, 10);
    const abs = path.resolve(baseDir, p);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new Error(`引用文件不存在: ${abs}`);
    }
    const lines = fs.readFileSync(abs, 'utf-8').split(/\r?\n/);
    if (start < 1 || end > lines.length || start > end) {
      throw new Error(`行号越界: ${abs} 共${lines.length}行, 请求${start}-${end}`);
    }
    return lines.slice(start - 1, end).join('\n');
  });
}

// ── file_read ─────────────────────────────────────────────
registerTool('file_read', async function* (args, ctx): AsyncGenerator<string, ToolResult> {
  const rawPath = args.path || '';
  const abs = resolvePath(ctx, rawPath);
  yield `[Action] Reading file: ${abs}\n`;
  const start = Math.max(1, args.start ?? 1);
  const count = Math.max(1, args.count ?? 200);
  const keyword: string | undefined = args.keyword;
  const showLinenos = args.show_linenos !== false;

  if (!fs.existsSync(abs)) {
    return { data: `Error: File not found: ${abs}`, nextPrompt: '\n' };
  }

  let text: string;
  try {
    text = fs.readFileSync(abs, 'utf-8');
  } catch (e: any) {
    return { data: `Error: ${e.message}`, nextPrompt: '\n' };
  }

  const allLines = text.split(/\r?\n/);
  const totalLines = allLines.length;
  let beginIdx = start - 1;

  if (keyword) {
    const lower = keyword.toLowerCase();
    let found = -1;
    for (let i = beginIdx; i < allLines.length; i++) {
      if (allLines[i].toLowerCase().includes(lower)) {
        found = i;
        break;
      }
    }
    if (found < 0) {
      const fallback = allLines.slice(beginIdx, beginIdx + count);
      const body = fallback.map((l, i) => (showLinenos ? `${beginIdx + i + 1}|${l}` : l)).join('\n');
      return {
        data: `Keyword '${keyword}' not found after line ${start}. Falling back:\n\n${body}`,
        nextPrompt: '\n',
      };
    }
    const ctxBefore = Math.floor(count / 3);
    beginIdx = Math.max(0, found - ctxBefore);
  }

  const slice = allLines.slice(beginIdx, beginIdx + count);
  const Lmax = Math.min(Math.max(100, Math.floor(256000 / Math.max(slice.length, 1))), 8000);
  const TAG = ' ... [TRUNCATED]';
  const trimmed = slice.map((l) => (l.length > Lmax ? l.slice(0, Lmax) + TAG : l));
  const body = trimmed.map((l, i) => (showLinenos ? `${beginIdx + i + 1}|${l}` : l)).join('\n');
  const header = showLinenos ? `[FILE] Total ${totalLines} lines\n` : '';
  let result = header + body;
  if (showLinenos) result = '由于设置了show_linenos，以下返回信息为：(行号|)内容 。\n' + result;
  if (result.includes(' ... [TRUNCATED]'))
    result += '\n\n（某些行被截断，如需完整内容可改用 code_run 读取）';
  result = smartFormat(result, 20000, '\n\n[omitted long content]\n\n');

  // 记录 memory 访问（类似 ga.py log_memory_access）
  const isMemFile = abs.startsWith(ctx.memoryDir) || abs.includes('memory');
  if (isMemFile) {
    try {
      const statsFile = path.join(ctx.memoryDir, 'file_access_stats.json');
      let stats: Record<string, any> = {};
      if (fs.existsSync(statsFile)) stats = JSON.parse(fs.readFileSync(statsFile, 'utf-8'));
      const fname = path.basename(abs);
      stats[fname] = {
        count: (stats[fname]?.count || 0) + 1,
        last: new Date().toISOString().slice(0, 10),
      };
      fs.mkdirSync(path.dirname(statsFile), { recursive: true });
      fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2));
    } catch { /* ignore */ }
  }

  let nextPrompt = '\n';
  if (isMemFile || /sop/i.test(abs)) {
    nextPrompt += '\n[SYSTEM TIPS] 正在读取记忆或SOP文件，若决定按sop执行请提取sop中的关键点（特别是靠后的）update working memory.';
  }
  return { data: result, nextPrompt };
});

// ── file_write ────────────────────────────────────────────
registerTool('file_write', async function* (args, ctx): AsyncGenerator<string, ToolResult> {
  const rawPath = args.path || '';
  const mode: 'overwrite' | 'append' | 'prepend' = args.mode || 'overwrite';
  const category: FileCategory | undefined = args.category;
  const description: string | undefined = args.description;

  // 文件路由：如果指定了 category，使用 FileManager 路由
  let abs: string;
  if (ctx.fileManager && category) {
    abs = ctx.fileManager.routeFile(rawPath, category);
  } else {
    abs = resolvePath(ctx, rawPath);
  }

  const actionStr = { prepend: 'Prepending to', append: 'Appending to', overwrite: 'Overwriting' }[mode];
  const displayPath = path.basename(abs);
  yield `[Action] ${actionStr} file: ${displayPath}\n`;

  let content: string = args.content ?? '';
  // 也支持从回复正文 <file_content> / ``` 提取
  if (!content && ctx.responseContent) {
    const tagMatch = ctx.responseContent.match(/<file_content[^>]*>([\s\S]*?)<\/file_content>/);
    if (tagMatch) content = tagMatch[1].trim();
    else {
      const s = ctx.responseContent.indexOf('```');
      const e = ctx.responseContent.lastIndexOf('```');
      if (s >= 0 && e > s) {
        const startNl = ctx.responseContent.indexOf('\n', s);
        if (startNl > 0 && startNl < e) content = ctx.responseContent.slice(startNl + 1, e).trim();
      }
    }
  }
  if (!content) {
    return {
      data: { status: 'error', msg: '未找到内容，请在 args.content 或 <file_content>/``` 块中提供' },
      nextPrompt: '\n',
    };
  }

  try {
    content = expandFileRefs(content, ctx.cwd);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (mode === 'prepend') {
      const old = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : '';
      fs.writeFileSync(abs, content + old);
    } else if (mode === 'append') {
      fs.appendFileSync(abs, content);
    } else {
      fs.writeFileSync(abs, content);
    }
    yield `[Status] ${mode} 成功 (${content.length} bytes)\n`;

    // 注册到 FileManager
    if (ctx.fileManager) {
      const actualCategory = category || ctx.fileManager.inferCategory(abs);
      ctx.fileManager.registerFile(abs, actualCategory, ctx.sessionId, description);
    }

    // 返回实际写入路径
    return {
      data: {
        status: 'success',
        writed_bytes: content.length,
        path: abs,
        category: category || (ctx.fileManager?.inferCategory(abs)),
      },
      nextPrompt: '\n',
    };
  } catch (e: any) {
    yield `[Status] 写入异常: ${e.message}\n`;
    return { data: { status: 'error', msg: e.message }, nextPrompt: '\n' };
  }
});

// ── file_patch ────────────────────────────────────────────
registerTool('file_patch', async function* (args, ctx): AsyncGenerator<string, ToolResult> {
  const rawPath = args.path || '';
  const abs = resolvePath(ctx, rawPath);
  yield `[Action] Patching file: ${abs}\n`;
  const oldContent: string = args.old_content || '';
  let newContent: string = args.new_content ?? '';
  if (!oldContent) {
    return { data: { status: 'error', msg: 'old_content 为空' }, nextPrompt: '\n' };
  }
  try {
    newContent = expandFileRefs(newContent, ctx.cwd);
    if (!fs.existsSync(abs)) {
      return { data: { status: 'error', msg: '文件不存在' }, nextPrompt: '\n' };
    }
    const full = fs.readFileSync(abs, 'utf-8');
    const parts = full.split(oldContent);
    const count = parts.length - 1;
    if (count === 0) {
      return {
        data: {
          status: 'error',
          msg: '未找到匹配的旧文本块。建议先用 file_read 确认当前内容后再分小段 patch。',
        },
        nextPrompt: '\n',
      };
    }
    if (count > 1) {
      return {
        data: {
          status: 'error',
          msg: `找到 ${count} 处匹配，请提供更长更具体的旧文本块以确保唯一性`,
        },
        nextPrompt: '\n',
      };
    }
    fs.writeFileSync(abs, parts.join(newContent));
    yield `\n文件局部修改成功\n`;
    
    // 注册到 FileManager
    if (ctx.fileManager) {
      const category = ctx.fileManager.inferCategory(abs);
      ctx.fileManager.registerFile(abs, category, ctx.sessionId);
    }
    
    return { data: { status: 'success', msg: '文件局部修改成功' }, nextPrompt: '\n' };
  } catch (e: any) {
    return { data: { status: 'error', msg: e.message }, nextPrompt: '\n' };
  }
});
