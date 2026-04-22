// ═══════════════════════════════════════════════════════════════
//  Electron preload 脚本 —— 将 IPC 暴露为 window.xagent
// ═══════════════════════════════════════════════════════════════

import { contextBridge, ipcRenderer } from 'electron';
import type { AppSettings, MainEvent, UIMessage } from '@shared/types';

const api = {
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  saveSettings: (s: AppSettings) => ipcRenderer.invoke('settings:save', s),
  listLLMs: () => ipcRenderer.invoke('llm:list'),
  switchLLM: (name: string) => ipcRenderer.invoke('llm:switch', name),
  sendTask: (query: string) => ipcRenderer.invoke('task:send', query),
  abortTask: () => ipcRenderer.invoke('task:abort'),
  answerAskUser: (answer: string) => ipcRenderer.invoke('ask:answer', answer),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  listConversations: () => ipcRenderer.invoke('conv:list'),
  loadConversation: (id: string): Promise<UIMessage[]> => ipcRenderer.invoke('conv:load', id),
  getCurrentConversation: (): Promise<{ id: string | null; messages: UIMessage[] }> =>
    ipcRenderer.invoke('conv:current'),
  deleteConversation: (id: string): Promise<boolean> => ipcRenderer.invoke('conv:delete', id),
  deleteAllConversations: (): Promise<number> => ipcRenderer.invoke('conv:delete-all'),
  openUserData: () => ipcRenderer.invoke('conv:open-userdata'),
  openDevTools: () => ipcRenderer.invoke('devtools:open'),
  onEvent: (cb: (evt: MainEvent) => void) => {
    const handler = (_e: any, evt: MainEvent) => cb(evt);
    ipcRenderer.on('xagent:event', handler);
    const userHandler = (_e: any, msg: UIMessage) => cb({ type: 'user-msg', msg });
    ipcRenderer.on('xagent:user-msg', userHandler);
    return () => {
      ipcRenderer.removeListener('xagent:event', handler);
      ipcRenderer.removeListener('xagent:user-msg', userHandler);
    };
  },
};

contextBridge.exposeInMainWorld('xagent', api);
