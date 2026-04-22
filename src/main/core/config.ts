// ═══════════════════════════════════════════════════════════════
//  配置 & 历史持久化
// ═══════════════════════════════════════════════════════════════

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AppSettings, UIMessage } from '@shared/types';

const DEFAULT_SETTINGS: AppSettings = {
  llms: [],
  active_llm: undefined,
  cwd: './workdir',
  memory_dir: './memory',
  lang: 'zh',
  log_requests: true,
};

export class ConfigStore {
  private settingsPath: string;
  private historyDir: string;
  private logDir: string;

  constructor(userDataDir: string) {
    this.settingsPath = path.join(userDataDir, 'settings.json');
    this.historyDir = path.join(userDataDir, 'conversations');
    this.logDir = path.join(userDataDir, 'logs');
    fs.mkdirSync(this.historyDir, { recursive: true });
    fs.mkdirSync(this.logDir, { recursive: true });
  }

  loadSettings(): AppSettings {
    if (!fs.existsSync(this.settingsPath)) {
      this.saveSettings(DEFAULT_SETTINGS);
      return { ...DEFAULT_SETTINGS };
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.settingsPath, 'utf-8'));
      return { ...DEFAULT_SETTINGS, ...raw };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  saveSettings(settings: AppSettings): void {
    fs.writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2));
  }

  /** 解析 cwd（相对路径基于 userDataDir） */
  resolveCwd(cwd: string | undefined, userDataDir: string): string {
    const c = cwd || './workdir';
    return path.isAbsolute(c) ? c : path.resolve(userDataDir, c);
  }

  /**
   * 解析 memory 目录：
   *  - 绝对路径：原样使用
   *  - 相对路径：基于 userDataDir（确保打包后可写）
   *  - 未配置：默认 userDataDir/memory
   * memory 与 workdir 解耦，保持稳定位置。
   */
  resolveMemoryDir(memoryDir: string | undefined, userDataDir: string): string {
    const m = memoryDir && memoryDir.trim() ? memoryDir.trim() : './memory';
    return path.isAbsolute(m) ? m : path.resolve(userDataDir, m);
  }

  listConversations(): { id: string; title: string; updatedAt: number }[] {
    if (!fs.existsSync(this.historyDir)) return [];
    const files = fs.readdirSync(this.historyDir).filter((f) => f.endsWith('.json'));
    const items = files.map((f) => {
      const p = path.join(this.historyDir, f);
      try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
        return {
          id: f.replace(/\.json$/, ''),
          title: raw.title || '未命名对话',
          updatedAt: raw.updatedAt || fs.statSync(p).mtimeMs,
        };
      } catch {
        return null;
      }
    });
    return items.filter(Boolean).sort((a: any, b: any) => b.updatedAt - a.updatedAt) as any;
  }

  saveConversation(id: string, messages: UIMessage[], title?: string): void {
    const p = path.join(this.historyDir, `${id}.json`);
    fs.writeFileSync(
      p,
      JSON.stringify(
        {
          id,
          title: title || messages.find((m) => m.role === 'user')?.content.slice(0, 30) || '新对话',
          updatedAt: Date.now(),
          messages,
        },
        null,
        2,
      ),
    );
  }

  loadConversation(id: string): UIMessage[] {
    const p = path.join(this.historyDir, `${id}.json`);
    if (!fs.existsSync(p)) return [];
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return raw.messages || [];
    } catch {
      return [];
    }
  }

  deleteConversation(id: string): boolean {
    const p = path.join(this.historyDir, `${id}.json`);
    if (!fs.existsSync(p)) return false;
    try {
      fs.unlinkSync(p);
      return true;
    } catch {
      return false;
    }
  }

  deleteAllConversations(): number {
    if (!fs.existsSync(this.historyDir)) return 0;
    const files = fs.readdirSync(this.historyDir).filter((f) => f.endsWith('.json'));
    let n = 0;
    for (const f of files) {
      try {
        fs.unlinkSync(path.join(this.historyDir, f));
        n++;
      } catch { /* ignore */ }
    }
    return n;
  }

  logRequest(pid: number | string, content: string): void {
    const p = path.join(this.logDir, `model_requests_${pid}.txt`);
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    fs.appendFileSync(p, `=== API Request === ${ts}\n${content}\n\n`);
  }
}
