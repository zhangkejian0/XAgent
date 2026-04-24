// ═══════════════════════════════════════════════════════════════
//  技能管理（L3 SOP / Utils）
//  - listSkills：扫描 memory 目录中的 *.md / *.py，过滤 L0/L1/L2 元文件
//  - readSkill：读取技能详情
//  - exportSkill：导出为 Anthropic Agent Skills 标准目录包
//      <exportRoot>/<skill-name>/SKILL.md
//      <exportRoot>/<skill-name>/scripts/<files>...
// ═══════════════════════════════════════════════════════════════

import * as fs from 'node:fs';
import * as path from 'node:path';

export type SkillFileType = 'md' | 'py' | 'other';

export interface SkillItem {
  /** 技能 ID（kebab-case，导出目录名） */
  id: string;
  /** 显示名（去扩展名的原始 basename） */
  name: string;
  /** 真实文件名（带扩展名） */
  fileName: string;
  /** 绝对路径 */
  absPath: string;
  /** 相对 memory 目录路径（展示用） */
  relPath: string;
  /** 文件类型 */
  type: SkillFileType;
  /** 大小 (bytes) */
  size: number;
  /** 最后修改时间 ISO */
  updatedAt: string;
  /** 一句话描述（自动提取） */
  description: string;
  /** 内容预览（截断） */
  preview: string;
  /** 关联脚本（同 basename 前缀的 .py/.sh/.js） */
  attachments: { fileName: string; absPath: string; size: number }[];
  /** 访问统计（来自 file_access_stats.json） */
  accessCount: number;
  /** 上次访问日期 */
  lastAccess?: string;
}

/** memory 根目录下不算"技能"的保留文件 */
const RESERVED_FILES = new Set([
  'global_mem.txt',
  'global_mem_insight.txt',
  'memory_management_sop.md',
  'file_access_stats.json',
]);

/** 不扫描的子目录 */
const SKIP_DIRS = new Set(['L4_raw_sessions', 'skill_search']);

const SKILL_EXTS = new Set(['.md', '.py']);
const ATTACHMENT_EXTS = new Set(['.py', '.sh', '.js', '.mjs', '.ts', '.ps1', '.bat']);

/** 文件名 → kebab-case ID */
function toKebab(name: string): string {
  return name
    .replace(/[_\s]+/g, '-')
    .replace(/[^A-Za-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase() || 'unnamed-skill';
}

/** 提取 description：优先 H1 后第一段非空文本，回退首行非空 */
function extractDescription(content: string, fileType: SkillFileType): string {
  const lines = content.split(/\r?\n/);
  if (fileType === 'md') {
    let h1Idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^#\s+/.test(lines[i])) { h1Idx = i; break; }
    }
    const start = h1Idx >= 0 ? h1Idx + 1 : 0;
    for (let i = start; i < Math.min(lines.length, start + 30); i++) {
      const l = lines[i].trim();
      if (!l) continue;
      if (l.startsWith('#')) continue;
      if (l.startsWith('---')) continue;
      const clean = l.replace(/^[-*>\s]+/, '').replace(/`/g, '').trim();
      if (clean.length >= 6) return truncate(clean, 160);
    }
    if (h1Idx >= 0) return truncate(lines[h1Idx].replace(/^#+\s*/, '').trim(), 160);
  } else if (fileType === 'py') {
    const m = content.match(/^"""([\s\S]*?)"""/m) || content.match(/^'''([\s\S]*?)'''/m);
    if (m) {
      const first = m[1].split(/\r?\n/).map(s => s.trim()).find(s => s);
      if (first) return truncate(first, 160);
    }
    for (const l of lines.slice(0, 30)) {
      const t = l.trim();
      if (t.startsWith('#') && t.length > 2) return truncate(t.replace(/^#+\s*/, ''), 160);
    }
  }
  for (const l of lines) {
    const t = l.trim();
    if (t) return truncate(t, 160);
  }
  return '（暂无描述）';
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** 读取访问统计 */
function loadAccessStats(memoryDir: string): Record<string, { count: number; last: string }> {
  const f = path.join(memoryDir, 'file_access_stats.json');
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return {}; }
}

/** 收集与某技能 basename 同前缀的脚本附件（同目录） */
function collectAttachments(skillAbs: string): SkillItem['attachments'] {
  const dir = path.dirname(skillAbs);
  const baseNoExt = path.basename(skillAbs, path.extname(skillAbs));
  const out: SkillItem['attachments'] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (path.join(dir, e.name) === skillAbs) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!ATTACHMENT_EXTS.has(ext)) continue;
    const base = path.basename(e.name, ext);
    // 同名前缀（xxx_sop.md ↔ xxx_utils.py / xxx.py / xxx_helper.sh）
    const matchExact = base === baseNoExt;
    const matchPrefix =
      base.startsWith(baseNoExt + '_') ||
      baseNoExt.startsWith(base + '_') ||
      base.replace(/_(utils|helper|tools|script)$/, '') === baseNoExt.replace(/_sop$/, '');
    if (!matchExact && !matchPrefix) continue;
    const abs = path.join(dir, e.name);
    try {
      const stat = fs.statSync(abs);
      out.push({ fileName: e.name, absPath: abs, size: stat.size });
    } catch { /* ignore */ }
  }
  return out;
}

/** 递归扫描 memory 目录下的 L3 技能文件 */
export function listSkills(memoryDir: string): SkillItem[] {
  if (!fs.existsSync(memoryDir)) return [];
  const stats = loadAccessStats(memoryDir);
  const items: SkillItem[] = [];

  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (e.name.startsWith('.')) continue;
        walk(abs, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!SKILL_EXTS.has(ext)) continue;
      // 顶层保留文件不计入技能
      if (dir === memoryDir && RESERVED_FILES.has(e.name)) continue;

      let content = '';
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
        content = fs.readFileSync(abs, 'utf-8');
      } catch { continue; }

      const fileType: SkillFileType = ext === '.md' ? 'md' : ext === '.py' ? 'py' : 'other';
      const baseName = path.basename(e.name, ext);
      const acc = stats[e.name];

      items.push({
        id: toKebab(baseName),
        name: baseName,
        fileName: e.name,
        absPath: abs,
        relPath: path.relative(memoryDir, abs).replace(/\\/g, '/'),
        type: fileType,
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
        description: extractDescription(content, fileType),
        preview: truncate(content.replace(/\r/g, ''), 600),
        attachments: collectAttachments(abs),
        accessCount: acc?.count || 0,
        lastAccess: acc?.last,
      });
    }
  };

  walk(memoryDir, 0);
  // 按 accessCount 倒序、再按 mtime 倒序
  items.sort((a, b) =>
    (b.accessCount - a.accessCount) || (b.updatedAt.localeCompare(a.updatedAt)),
  );
  return items;
}

/** 读取单个技能的完整内容（含附件路径列表） */
export function readSkill(memoryDir: string, id: string): {
  skill: SkillItem | null;
  content: string;
} {
  const all = listSkills(memoryDir);
  const skill = all.find(s => s.id === id) || null;
  if (!skill) return { skill: null, content: '' };
  let content = '';
  try { content = fs.readFileSync(skill.absPath, 'utf-8'); } catch { /* ignore */ }
  return { skill, content };
}

/** 生成 SKILL.md 的 YAML frontmatter */
function buildFrontmatter(name: string, description: string): string {
  // YAML 安全：description 用单引号转义内部单引号
  const safeDesc = description.replace(/'/g, "''").replace(/[\r\n]+/g, ' ').trim();
  return `---\nname: ${name}\ndescription: '${safeDesc}'\n---\n`;
}

/** 生成 .py 包装的 SKILL.md（当原始技能是 Python 脚本时） */
function buildPySkillMd(skill: SkillItem, scriptRelPath: string, content: string): string {
  const head = buildFrontmatter(skill.id, skill.description);
  return `${head}\n# ${skill.name}\n\n${skill.description}\n\n## 用法\n\n这是一个 Python 工具脚本。直接执行：\n\n\`\`\`bash\npython ${scriptRelPath}\n\`\`\`\n\n## 源码\n\n\`\`\`python\n${content.trim()}\n\`\`\`\n`;
}

export interface ExportResult {
  ok: boolean;
  path?: string;
  message?: string;
  files?: string[];
}

/**
 * 导出技能为 Anthropic Agent Skills 标准目录包
 * 结构：
 *   <exportRoot>/<skill-id>/SKILL.md
 *   <exportRoot>/<skill-id>/scripts/<attachment files>
 */
export function exportSkill(
  memoryDir: string,
  id: string,
  exportRoot: string,
): ExportResult {
  const { skill, content } = readSkill(memoryDir, id);
  if (!skill) return { ok: false, message: `未找到技能: ${id}` };
  if (!exportRoot) return { ok: false, message: '导出目录为空' };

  try {
    fs.mkdirSync(exportRoot, { recursive: true });
  } catch (e: any) {
    return { ok: false, message: `创建导出目录失败: ${e.message}` };
  }

  const skillDir = path.join(exportRoot, skill.id);
  // 若已存在追加时间戳，避免覆盖
  let finalDir = skillDir;
  if (fs.existsSync(skillDir)) {
    const ts = new Date().toISOString().replace(/[:T.]/g, '').slice(0, 14);
    finalDir = `${skillDir}_${ts}`;
  }
  fs.mkdirSync(finalDir, { recursive: true });
  const scriptsDir = path.join(finalDir, 'scripts');

  const writtenFiles: string[] = [];

  if (skill.type === 'md') {
    const head = buildFrontmatter(skill.id, skill.description);
    let body = content.replace(/^---[\s\S]*?---\s*/m, '');
    if (!/^#\s+/.test(body.trim())) {
      body = `# ${skill.name}\n\n${body.trim()}\n`;
    }
    const md = `${head}\n${body.trim()}\n`;
    const skillMdPath = path.join(finalDir, 'SKILL.md');
    fs.writeFileSync(skillMdPath, md, 'utf-8');
    writtenFiles.push(path.relative(exportRoot, skillMdPath));

    // 附件 → scripts/
    if (skill.attachments.length > 0) {
      fs.mkdirSync(scriptsDir, { recursive: true });
      for (const a of skill.attachments) {
        try {
          const dst = path.join(scriptsDir, a.fileName);
          fs.copyFileSync(a.absPath, dst);
          writtenFiles.push(path.relative(exportRoot, dst));
        } catch { /* skip */ }
      }
    }
  } else if (skill.type === 'py') {
    fs.mkdirSync(scriptsDir, { recursive: true });
    const scriptName = skill.fileName;
    const scriptDst = path.join(scriptsDir, scriptName);
    fs.copyFileSync(skill.absPath, scriptDst);
    writtenFiles.push(path.relative(exportRoot, scriptDst));

    const skillMd = buildPySkillMd(skill, `scripts/${scriptName}`, content);
    const skillMdPath = path.join(finalDir, 'SKILL.md');
    fs.writeFileSync(skillMdPath, skillMd, 'utf-8');
    writtenFiles.push(path.relative(exportRoot, skillMdPath));

    // 同时也带上其他相关脚本附件
    for (const a of skill.attachments) {
      try {
        const dst = path.join(scriptsDir, a.fileName);
        if (!fs.existsSync(dst)) {
          fs.copyFileSync(a.absPath, dst);
          writtenFiles.push(path.relative(exportRoot, dst));
        }
      } catch { /* skip */ }
    }
  } else {
    return { ok: false, message: `不支持的技能类型: ${skill.type}` };
  }

  // 自动写一份 README.md，说明来源
  try {
    const readmePath = path.join(finalDir, 'README.md');
    const readme =
      `# ${skill.name}\n\n来源：XAgent 长期记忆 (L3) — ${skill.relPath}\n\n` +
      `导出时间：${new Date().toLocaleString('zh-CN')}\n\n` +
      `这是一个 [Anthropic Agent Skills](https://docs.anthropic.com/) 兼容的技能包，` +
      `把整个 \`${skill.id}/\` 目录拷贝至支持 Skills 的客户端（如 \`~/.claude/skills/\` 或 ` +
      `\`<workspace>/.cursor/skills/\`）即可被 Agent 自动识别加载。\n`;
    fs.writeFileSync(readmePath, readme, 'utf-8');
    writtenFiles.push(path.relative(exportRoot, readmePath));
  } catch { /* ignore */ }

  return { ok: true, path: finalDir, files: writtenFiles };
}

/** 构造"复用技能"时发给 LLM 的 prompt */
export function buildReusePrompt(skill: SkillItem): string {
  return (
    `[USER REQUEST] 我希望复用一个已经沉淀在长期记忆里的技能。\n\n` +
    `**技能名**：${skill.name}\n` +
    `**文件路径**：${skill.absPath}\n` +
    `**一句话描述**：${skill.description}\n` +
    (skill.attachments.length
      ? `**关联脚本**：${skill.attachments.map(a => a.fileName).join('、')}\n`
      : '') +
    `\n请你按以下步骤执行：\n` +
    `1. 使用 file_read 读取上述技能文件（必要时也读取关联脚本），全面理解其内容；\n` +
    `2. 用简洁的中文向我介绍：\n` +
    `   - 这个技能能解决什么问题；\n` +
    `   - 使用前需要哪些前置条件 / 环境；\n` +
    `   - 关键步骤、参数与示例命令；\n` +
    `   - 容易踩的坑及对应规避方式。\n` +
    `3. 询问我是否有具体的任务要立刻按此 SOP 执行；如果有就直接执行，没有就结束。\n` +
    `请保持回答精炼，避免冗长复述原文。`
  );
}
