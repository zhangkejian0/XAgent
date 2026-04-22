// ═══════════════════════════════════════════════════════════════
//  记忆系统（对齐 ga.py 的 get_global_memory）
//  memory 目录独立于 workdir，由 settings.memory_dir 配置
// ═══════════════════════════════════════════════════════════════

import * as fs from 'node:fs';
import * as path from 'node:path';

/** 确保 memory 目录与初始文件存在 */
export function initMemoryDir(memoryDir: string, assetsDir: string): string {
  fs.mkdirSync(memoryDir, { recursive: true });

  const memTxt = path.join(memoryDir, 'global_mem.txt');
  if (!fs.existsSync(memTxt)) fs.writeFileSync(memTxt, '# [Global Memory - L2]\n');

  const memInsight = path.join(memoryDir, 'global_mem_insight.txt');
  if (!fs.existsSync(memInsight)) {
    const tmpl = path.join(assetsDir, 'global_mem_insight_template.txt');
    const content = fs.existsSync(tmpl) ? fs.readFileSync(tmpl, 'utf-8') : '';
    fs.writeFileSync(memInsight, content);
  }

  const sopMd = path.join(memoryDir, 'memory_management_sop.md');
  if (!fs.existsSync(sopMd)) {
    const tmpl = path.join(assetsDir, 'memory_management_sop.md');
    if (fs.existsSync(tmpl)) fs.writeFileSync(sopMd, fs.readFileSync(tmpl, 'utf-8'));
  }

  fs.mkdirSync(path.join(memoryDir, 'L4_raw_sessions'), { recursive: true });
  return memoryDir;
}

/**
 * 生成记忆索引片段（注入 system prompt）。
 * memoryDir 使用绝对路径，让模型能用绝对路径访问。
 */
export function getMemoryPrompt(cwd: string, memoryDir: string, assetsDir?: string): string {
  try {
    // 给模型展示的 memory 路径：优先相对于 cwd，否则绝对路径
    const rel = path.relative(cwd, memoryDir).replace(/\\/g, '/');
    const memDisplay = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `./${rel}` : memoryDir;

    let prompt = `\ncwd = ${cwd}\nMemoryDir = ${memoryDir}\n\n[Memory] (${memDisplay})\n`;
    const assets = assetsDir || path.join(__dirname, '..', '..', '..', 'assets');
    const structureFile = path.join(assets, 'insight_fixed_structure.txt');
    const structure = fs.existsSync(structureFile) ? fs.readFileSync(structureFile, 'utf-8') : '';
    // 把模板中的 ./memory 占位符替换成实际 memoryDir 展示值
    prompt += structure.replace(/\.\/memory/g, memDisplay) + '\n';

    const insightFile = path.join(memoryDir, 'global_mem_insight.txt');
    if (fs.existsSync(insightFile)) {
      prompt += `\n${memDisplay}/global_mem_insight.txt:\n`;
      prompt += fs.readFileSync(insightFile, 'utf-8') + '\n';
    }
    return prompt;
  } catch {
    return '';
  }
}

/** 生成系统提示词（sys_prompt + 日期 + memory insight） */
export function getSystemPrompt(cwd: string, memoryDir: string, assetsDir: string): string {
  const sysFile = path.join(assetsDir, 'sys_prompt.txt');
  const sys = fs.existsSync(sysFile) ? fs.readFileSync(sysFile, 'utf-8') : '';
  const today = new Date().toDateString();
  return `${sys}\nToday: ${today}\n${getMemoryPrompt(cwd, memoryDir, assetsDir)}`;
}

/** 记录访问统计 */
export function logMemoryAccess(filePath: string, memoryDir: string): void {
  if (!filePath.includes('memory')) return;
  const statsFile = path.join(memoryDir, 'file_access_stats.json');
  let stats: Record<string, any> = {};
  try {
    if (fs.existsSync(statsFile)) stats = JSON.parse(fs.readFileSync(statsFile, 'utf-8'));
  } catch { /* ignore */ }
  const fname = path.basename(filePath);
  stats[fname] = {
    count: (stats[fname]?.count || 0) + 1,
    last: new Date().toISOString().slice(0, 10),
  };
  try {
    fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2));
  } catch { /* ignore */ }
}
