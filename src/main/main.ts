// ═══════════════════════════════════════════════════════════════
//  Electron 主进程入口
// ═══════════════════════════════════════════════════════════════

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { AppSettings, MainEvent, UIMessage } from '@shared/types';
import { buildSessions, type LLMSession } from './core/llmcore.js';
import { runAgentLoop, type AgentEvent } from './core/agentLoop.js';
import { ConfigStore } from './core/config.js';
import { initMemoryDir, getSystemPrompt } from './core/memory.js';
import { FileManager } from './core/fileManager.js';

// ─── 全局状态 ────────────────────────────────────────────────
let mainWindow: BrowserWindow | null = null;
let configStore: ConfigStore;
let settings: AppSettings;
let sessions: Map<string, LLMSession> = new Map();
let activeSession: LLMSession | null = null;
let tools: any[] = [];
let stopSignal = { aborted: false };
let currentConversationId: string | null = null;
let conversationMessages: UIMessage[] = [];
let pendingAskUser: {
  resolve: (answer: string) => void;
  question: string;
} | null = null;

// 资源路径：dist/main/main/main.js → ../../../assets
function getAssetsDir(): string {
  const devPath = path.resolve(__dirname, '..', '..', '..', 'assets');
  const prodPath = path.join(app.getAppPath(), 'assets');
  if (fs.existsSync(devPath)) return devPath;
  if (fs.existsSync(prodPath)) return prodPath;
  return devPath;
}

function getUserDataDir(): string {
  return app.getPath('userData');
}

// ─── 初始化 ──────────────────────────────────────────────────
function initializeSessions(): void {
  sessions = buildSessions(settings.llms);
  if (settings.active_llm && sessions.has(settings.active_llm)) {
    activeSession = sessions.get(settings.active_llm)!;
  } else {
    activeSession = sessions.values().next().value || null;
  }
}

function loadTools(): void {
  const schemaFile = path.join(getAssetsDir(), 'tools_schema.json');
  if (fs.existsSync(schemaFile)) {
    tools = JSON.parse(fs.readFileSync(schemaFile, 'utf-8'));
  } else {
    tools = [];
  }
}

// ─── 在主进程同步维护会话消息（持久化的真实数据源） ─────────
function trackAssistantEvent(evt: AgentEvent): void {
  if (evt.type === 'turn_start') {
    conversationMessages.push({
      id: evt.messageId,
      role: 'assistant',
      content: '',
      toolCalls: [],
      timestamp: Date.now(),
      turn: evt.turn,
      streaming: true,
    });
  } else if (evt.type === 'chunk') {
    const m = conversationMessages.find((x) => x.id === evt.messageId);
    if (m) m.content += evt.text;
  } else if (evt.type === 'tool_call') {
    const m = conversationMessages.find((x) => x.id === evt.messageId);
    if (m) m.toolCalls = [...(m.toolCalls || []), { ...evt.call }];
  } else if (evt.type === 'tool_result') {
    const m = conversationMessages.find((x) => x.id === evt.messageId);
    if (m && m.toolCalls) {
      m.toolCalls = m.toolCalls.map((tc) =>
        tc.id === evt.toolCallId ? { ...tc, result: evt.result, status: evt.status } : tc,
      );
    }
  } else if (evt.type === 'turn_end') {
    const m = conversationMessages[conversationMessages.length - 1];
    if (m) m.streaming = false;
    // 每一轮落盘一次
    persistCurrentConversation();
  } else if (evt.type === 'task_done') {
    persistCurrentConversation();
  }
}

function persistCurrentConversation(): void {
  if (!currentConversationId) return;
  try {
    configStore.saveConversation(currentConversationId, conversationMessages);
  } catch (e) {
    console.error('[persist] failed:', e);
  }
}

// ─── 事件转发：AgentEvent → MainEvent → renderer ─────────────
function emitToRenderer(evt: AgentEvent): void {
  // 先同步主进程状态（即使窗口已关闭也要保留消息到磁盘）
  trackAssistantEvent(evt);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  let mainEvt: MainEvent | null = null;

  switch (evt.type) {
    case 'turn_start':
      mainEvt = { type: 'turn_start', turn: evt.turn, messageId: evt.messageId };
      break;
    case 'chunk':
      mainEvt = { type: 'chunk', text: evt.text, messageId: evt.messageId };
      break;
    case 'tool_call':
      mainEvt = { type: 'tool_call', messageId: evt.messageId, call: evt.call };
      break;
    case 'tool_result':
      mainEvt = {
        type: 'tool_result',
        messageId: evt.messageId,
        toolCallId: evt.toolCallId,
        result: evt.result,
        status: evt.status,
      };
      break;
    case 'turn_end':
      mainEvt = { type: 'turn_end', turn: evt.turn };
      break;
    case 'task_done':
      mainEvt = { type: 'task_done', reason: evt.reason };
      break;
    case 'error':
      mainEvt = { type: 'error', message: evt.message };
      break;
    case 'ask_user':
      mainEvt = { type: 'ask_user', question: evt.question, candidates: evt.candidates };
      break;
    default:
      return;
  }
  mainWindow.webContents.send('xagent:event', mainEvt);
}

// ─── 创建主窗口 ──────────────────────────────────────────────
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1a1a1a',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#1a1a1a',
      symbolColor: '#e0e0e0',
      height: 36,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // dist/main/main/main.js → ../../renderer/index.html
    mainWindow.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── IPC 路由 ────────────────────────────────────────────────
function setupIPC(): void {
  ipcMain.handle('settings:get', () => settings);

  ipcMain.handle('settings:save', (_e, newSettings: AppSettings) => {
    settings = newSettings;
    configStore.saveSettings(settings);
    initializeSessions();
  });

  ipcMain.handle('llm:list', () => {
    const active = activeSession?.name;
    return Array.from(sessions.entries()).map(([name, s]) => ({
      name,
      type: s.constructor.name,
      active: name === active,
    }));
  });

  ipcMain.handle('llm:switch', (_e, name: string) => {
    if (sessions.has(name)) {
      const prevHistory = activeSession?.history || [];
      activeSession = sessions.get(name)!;
      // 保持历史连续
      if (prevHistory.length && activeSession.history.length === 0) {
        activeSession.history = prevHistory;
      }
      settings.active_llm = name;
      configStore.saveSettings(settings);
    }
  });

  ipcMain.handle('task:send', async (_e, query: string) => {
    if (!activeSession) {
      mainWindow?.webContents.send('xagent:event', {
        type: 'error',
        message: '未配置 LLM，请先在设置中添加',
      } as MainEvent);
      return { sessionId: '' };
    }
    stopSignal = { aborted: false };

    // 准备对话 ID
    if (!currentConversationId) {
      currentConversationId = `conv_${Date.now()}`;
      conversationMessages = [];
    }

    // 追加 user 消息到 UI（以及持久化）
    const userMsg: UIMessage = {
      id: `u_${Date.now()}`,
      role: 'user',
      content: query,
      timestamp: Date.now(),
    };
    conversationMessages.push(userMsg);
    persistCurrentConversation();
    mainWindow?.webContents.send('xagent:user-msg', userMsg);

    const workspaceDir = configStore.resolveCwd(settings.cwd, getUserDataDir());
    const memoryDir = configStore.resolveMemoryDir(settings.memory_dir, getUserDataDir());
    fs.mkdirSync(workspaceDir, { recursive: true });
    // 旧数据迁移：老版本 memory 曾经落在 workspaceDir/memory 下
    const legacyMem = path.join(workspaceDir, 'memory');
    if (!fs.existsSync(memoryDir) && fs.existsSync(legacyMem)) {
      try {
        fs.mkdirSync(path.dirname(memoryDir), { recursive: true });
        fs.renameSync(legacyMem, memoryDir);
        console.log(`[migrate] memory 迁移: ${legacyMem} → ${memoryDir}`);
      } catch (e) {
        console.warn('[migrate] memory 迁移失败（可忽略）:', e);
      }
    }
    initMemoryDir(memoryDir, getAssetsDir());

    // 初始化 FileManager
    const fileManager = new FileManager(workspaceDir);

    const systemPrompt =
      settings.system_prompt_override?.trim() ||
      getSystemPrompt(workspaceDir, memoryDir, getAssetsDir());

    const ctx = {
      cwd: workspaceDir,
      memoryDir,
      fileManager,
      sessionId: currentConversationId || undefined,
      working: {} as Record<string, any>,
      currentTurn: 0,
      historyInfo: [] as string[],
      settings,
      stopSignal,
      emit: () => { /* unused, UI via emitToRenderer */ },
      askUser: async (question: string, candidates?: string[]): Promise<string> => {
        return new Promise<string>((resolve) => {
          pendingAskUser = { resolve, question };
          mainWindow?.webContents.send('xagent:event', {
            type: 'ask_user',
            question,
            candidates,
          } as MainEvent);
        });
      },
      responseContent: '',
    };

    runAgentLoop({
      session: activeSession,
      userInput: query,
      systemPrompt,
      tools,
      ctx,
      maxTurns: 40,
      emit: (evt) => emitToRenderer(evt),
    })
      .then(() => persistCurrentConversation())
      .catch((e) => {
        persistCurrentConversation();
        mainWindow?.webContents.send('xagent:event', {
          type: 'error',
          message: String(e?.message || e),
        } as MainEvent);
      });

    return { sessionId: currentConversationId };
  });

  ipcMain.handle('task:abort', () => {
    stopSignal.aborted = true;
  });

  ipcMain.handle('ask:answer', (_e, answer: string) => {
    if (pendingAskUser) {
      pendingAskUser.resolve(answer);
      pendingAskUser = null;
    }
  });

  ipcMain.handle('history:clear', () => {
    if (activeSession) activeSession.clearHistory();
    conversationMessages = [];
    currentConversationId = null;
  });

  ipcMain.handle('conv:list', () => configStore.listConversations());

  ipcMain.handle('conv:load', (_e, id: string) => {
    currentConversationId = id;
    conversationMessages = configStore.loadConversation(id);
    // 切换时把历史消息同步到 LLM session（才能接续对话）
    if (activeSession) {
      activeSession.clearHistory();
      for (const m of conversationMessages) {
        if (m.role === 'user') {
          activeSession.history.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
        } else if (m.role === 'assistant' && !m.streaming) {
          activeSession.history.push({ role: 'assistant', content: [{ type: 'text', text: m.content }] });
        }
      }
    }
    return conversationMessages;
  });

  ipcMain.handle('conv:current', () => ({
    id: currentConversationId,
    messages: conversationMessages,
  }));

  ipcMain.handle('conv:delete', (_e, id: string) => {
    const ok = configStore.deleteConversation(id);
    if (ok && id === currentConversationId) {
      // 删的是当前会话，清空所有瞬态状态并通知渲染进程
      stopSignal.aborted = true;
      pendingAskUser = null;
      if (activeSession) activeSession.clearHistory();
      conversationMessages = [];
      currentConversationId = null;
      // 通知渲染进程重置 running 状态
      mainWindow?.webContents.send('xagent:event', { type: 'task_done', reason: 'deleted' });
    }
    return ok;
  });

  ipcMain.handle('conv:delete-all', () => {
    const n = configStore.deleteAllConversations();
    stopSignal.aborted = true;
    pendingAskUser = null;
    if (activeSession) activeSession.clearHistory();
    conversationMessages = [];
    currentConversationId = null;
    return n;
  });

  ipcMain.handle('conv:open-userdata', () => {
    shell.openPath(getUserDataDir());
  });

  ipcMain.handle('devtools:open', () => {
    mainWindow?.webContents.openDevTools({ mode: 'detach' });
  });

  // 重新拿回键盘焦点：原生 confirm/alert 关闭后，webContents 会失去键盘焦点，
  // 表现为 textarea 有聚焦边框但无光标、无法输入
  ipcMain.handle('window:focus', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.focus();
      mainWindow.webContents.focus();
    }
  });

  // 触发记忆更新：发送特殊消息让 Agent 调用 start_long_term_update
  ipcMain.handle('memory:trigger', async () => {
    if (!activeSession) {
      mainWindow?.webContents.send('xagent:event', {
        type: 'error',
        message: '未配置 LLM，请先在设置中添加',
      } as MainEvent);
      return { success: false };
    }
    if (conversationMessages.length === 0) {
      mainWindow?.webContents.send('xagent:event', {
        type: 'error',
        message: '当前对话为空，无法触发记忆更新',
      } as MainEvent);
      return { success: false };
    }

    stopSignal = { aborted: false };

    // 发送触发记忆的特殊指令
    const triggerQuery = '[USER REQUEST] 请根据本次对话内容，触发 start_long_term_update 工具，提炼并更新长期记忆。';

    const userMsg: UIMessage = {
      id: `u_${Date.now()}`,
      role: 'user',
      content: triggerQuery,
      timestamp: Date.now(),
    };
    conversationMessages.push(userMsg);
    persistCurrentConversation();
    mainWindow?.webContents.send('xagent:user-msg', userMsg);

    const workspaceDir = configStore.resolveCwd(settings.cwd, getUserDataDir());
    const memoryDir = configStore.resolveMemoryDir(settings.memory_dir, getUserDataDir());
    const fileManager = new FileManager(workspaceDir);
    const systemPrompt =
      settings.system_prompt_override?.trim() ||
      getSystemPrompt(workspaceDir, memoryDir, getAssetsDir());

    const ctx = {
      cwd: workspaceDir,
      memoryDir,
      fileManager,
      sessionId: currentConversationId || undefined,
      working: {} as Record<string, any>,
      currentTurn: 0,
      historyInfo: [] as string[],
      settings,
      stopSignal,
      emit: () => {},
      askUser: async (question: string, candidates?: string[]): Promise<string> => {
        return new Promise<string>((resolve) => {
          pendingAskUser = { resolve, question };
          mainWindow?.webContents.send('xagent:event', {
            type: 'ask_user',
            question,
            candidates,
          } as MainEvent);
        });
      },
      responseContent: '',
    };

    runAgentLoop({
      session: activeSession,
      userInput: triggerQuery,
      systemPrompt,
      tools,
      ctx,
      maxTurns: 10,
      emit: (evt) => emitToRenderer(evt),
    })
      .then(() => persistCurrentConversation())
      .catch((e) => {
        persistCurrentConversation();
        mainWindow?.webContents.send('xagent:event', {
          type: 'error',
          message: String(e?.message || e),
        } as MainEvent);
      });

    return { success: true };
  });

  // ─── 文件管理 IPC ────────────────────────────────────────────
  ipcMain.handle('files:list', () => {
    const workspaceDir = configStore.resolveCwd(settings.cwd, getUserDataDir());
    const fileManager = new FileManager(workspaceDir);
    return {
      files: fileManager.getFiles(),
      stats: fileManager.getStats(),
      // 显示真实工作目录，让用户清楚文件管理范围
      xagentDir: fileManager.getCwd(),
    };
  });

  ipcMain.handle('files:clean', (_e, categories?: string[]) => {
    const workspaceDir = configStore.resolveCwd(settings.cwd, getUserDataDir());
    const fileManager = new FileManager(workspaceDir);
    const cats = categories as any[];
    return fileManager.cleanFiles(cats);
  });

  ipcMain.handle('files:open-xagent-dir', () => {
    const workspaceDir = configStore.resolveCwd(settings.cwd, getUserDataDir());
    const fileManager = new FileManager(workspaceDir);
    // 打开工作目录（cwd），用户可在其中看到 .xagent 子目录及其他文件
    shell.openPath(fileManager.getCwd());
  });
}

// ─── 启动时恢复最近对话（并把历史注入 LLM session） ─────────
function restoreLatestConversation(): void {
  const convs = configStore.listConversations();
  if (!convs.length) return;
  const latest = convs[0];
  currentConversationId = latest.id;
  conversationMessages = configStore.loadConversation(latest.id);
  if (activeSession) {
    activeSession.clearHistory();
    for (const m of conversationMessages) {
      if (m.role === 'user') {
        activeSession.history.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
      } else if (m.role === 'assistant' && !m.streaming) {
        activeSession.history.push({
          role: 'assistant',
          content: [{ type: 'text', text: m.content }],
        });
      }
    }
  }
  console.log(`[restore] 已恢复最近对话 ${latest.id}（${conversationMessages.length} 条消息）`);
}

// ─── 应用生命周期 ────────────────────────────────────────────
app.whenReady().then(() => {
  configStore = new ConfigStore(getUserDataDir());
  settings = configStore.loadSettings();
  loadTools();
  initializeSessions();
  restoreLatestConversation();
  setupIPC();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 退出前兜底保存
app.on('before-quit', () => {
  persistCurrentConversation();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
