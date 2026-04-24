// ═══════════════════════════════════════════════════════════════
//  Web 工具：web_scan / web_execute_js
//  使用 Electron 自带的 BrowserWindow 作为可控浏览器
// ═══════════════════════════════════════════════════════════════

import * as fs from 'node:fs';
import * as path from 'node:path';
import { registerTool, type ToolContext, type ToolResult } from './types.js';
import type { FileCategory } from '../fileManager.js';

/** 浏览器窗口管理（延迟加载 Electron，避免非渲染环境 import 失败） */
class WebDriver {
  private windows = new Map<string, any>();
  private activeTabId: string | null = null;

  private async getElectron(): Promise<any> {
    try {
      return await import('electron');
    } catch {
      return null;
    }
  }

  async openTab(url: string): Promise<string> {
    const electron = await this.getElectron();
    if (!electron?.BrowserWindow) {
      throw new Error('Electron 不可用：web 工具需在 Electron 主进程中运行');
    }
    const { BrowserWindow } = electron;
    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      show: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    await win.loadURL(url);
    const id = 'tab_' + Math.random().toString(36).slice(2, 10);
    this.windows.set(id, win);
    this.activeTabId = id;
    win.on('closed', () => {
      this.windows.delete(id);
      if (this.activeTabId === id) this.activeTabId = null;
    });
    return id;
  }

  async getAllTabs(): Promise<{ id: string; url: string; title: string }[]> {
    const tabs: { id: string; url: string; title: string }[] = [];
    for (const [id, win] of this.windows) {
      if (win.isDestroyed()) continue;
      try {
        const url = win.webContents.getURL();
        const title = win.webContents.getTitle();
        tabs.push({ id, url, title });
      } catch { /* ignore */ }
    }
    return tabs;
  }

  async switchTab(id: string): Promise<boolean> {
    if (this.windows.has(id)) {
      this.activeTabId = id;
      this.windows.get(id)?.focus();
      return true;
    }
    return false;
  }

  getActiveWindow(): any | null {
    if (!this.activeTabId) return null;
    return this.windows.get(this.activeTabId) || null;
  }

  async executeJS(script: string, tabId?: string): Promise<any> {
    if (tabId) await this.switchTab(tabId);
    const win = this.getActiveWindow();
    if (!win) throw new Error('没有活动的浏览器标签页，请先 web_scan 打开 URL');
    return await win.webContents.executeJavaScript(script, true);
  }

  async getSimplifiedHTML(tabId?: string, textOnly = false): Promise<string> {
    if (tabId) await this.switchTab(tabId);
    const win = this.getActiveWindow();
    if (!win) throw new Error('没有活动的浏览器标签页');
    const script = textOnly
      ? `document.body ? document.body.innerText.slice(0, 35000) : ''`
      : `(function(){
          const clone = document.body ? document.body.cloneNode(true) : null;
          if (!clone) return '';
          clone.querySelectorAll('script,style,link,noscript,svg,iframe').forEach(el => el.remove());
          clone.querySelectorAll('[style*="display: none"],[style*="visibility: hidden"]').forEach(el => el.remove());
          return clone.outerHTML.slice(0, 35000);
        })()`;
    return await win.webContents.executeJavaScript(script, true);
  }
}

const driver = new WebDriver();

function smartFormat(s: string, maxLen: number, omit = '\n\n[omitted]\n\n'): string {
  if (s.length < maxLen + omit.length * 2) return s;
  const half = Math.floor(maxLen / 2);
  return s.slice(0, half) + omit + s.slice(-half);
}

// ── web_scan ─────────────────────────────────────────────
registerTool('web_scan', async function* (args, ctx: ToolContext): AsyncGenerator<string, ToolResult> {
  const tabsOnly = !!args.tabs_only;
  const textOnly = !!args.text_only;
  const switchTabId: string | undefined = args.switch_tab_id;
  const url: string | undefined = args.url;

  try {
    if (url) {
      const id = await driver.openTab(url);
      yield `[Action] Opened tab: ${id} -> ${url}\n`;
    } else if (switchTabId) {
      const ok = await driver.switchTab(switchTabId);
      if (!ok) yield `[Warn] 标签页 ${switchTabId} 不存在\n`;
    }

    const tabs = await driver.getAllTabs();
    if (!tabs.length) {
      return { data: { status: 'error', msg: '没有可用的浏览器标签页' }, nextPrompt: '\n' };
    }

    const result: any = {
      status: 'success',
      metadata: { tabs_count: tabs.length, tabs },
    };
    if (!tabsOnly) {
      result.content = await driver.getSimplifiedHTML(undefined, textOnly);
    }
    yield `[Info] tabs=${tabs.length}\n`;
    const content = result.content;
    delete result.content;
    let out: any = result;
    if (content) out = JSON.stringify(result, null, 2) + `\n\`\`\`html\n${content}\n\`\`\``;
    return { data: out, nextPrompt: '\n' };
  } catch (e: any) {
    return { data: { status: 'error', msg: e.message }, nextPrompt: '\n' };
  }
});

// ── web_execute_js ────────────────────────────────────────
registerTool('web_execute_js', async function* (args, ctx: ToolContext): AsyncGenerator<string, ToolResult> {
  let script: string = args.script || '';
  if (!script && ctx.responseContent) {
    const m = [...ctx.responseContent.matchAll(/```javascript\n([\s\S]*?)\n```/g)];
    if (m.length) script = m[m.length - 1][1].trim();
  }
  if (!script) {
    return { data: '[Error] Script missing', nextPrompt: '\n' };
  }

  const tabId: string | undefined = args.switch_tab_id || args.tab_id;
  const saveTo: string | undefined = args.save_to_file;

  try {
    const ret = await driver.executeJS(script, tabId);
    const result: any = { status: 'success', js_return: ret };
    if (saveTo && ret !== undefined && ret !== null) {
      const abs = path.isAbsolute(saveTo) ? saveTo : path.resolve(ctx.cwd, saveTo);
      const content = typeof ret === 'string' ? ret : JSON.stringify(ret, null, 2);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      result.js_return = smartFormat(String(ret), 170);
      result.js_return += `\n\n[已保存完整内容到 ${abs}]`;
      
      // 注册到 FileManager
      if (ctx.fileManager) {
        const category = ctx.fileManager.inferCategory(abs);
        ctx.fileManager.registerFile(abs, category, ctx.sessionId);
      }
    }
    const show = smartFormat(JSON.stringify(result, null, 2), 300);
    yield `JS 执行结果:\n${show}\n`;
    return { data: smartFormat(JSON.stringify(result), 8000), nextPrompt: '\n' };
  } catch (e: any) {
    return { data: { status: 'error', msg: e.message }, nextPrompt: '\n' };
  }
});
