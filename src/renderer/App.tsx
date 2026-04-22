import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings, MainEvent, UIMessage } from '@shared/types';
import { MessageBubble } from './components/MessageBubble';
import { InputBar, type InputBarHandle } from './components/InputBar';
import { SettingsPanel } from './components/SettingsPanel';
import { ConfirmDialog } from './components/ConfirmDialog';

interface ConvItem { id: string; title: string; updatedAt: number; }

interface AskState { question: string; candidates?: string[] }

interface ConfirmState {
  message: string;
  title?: string;
  onConfirm: () => void | Promise<void>;
}

export const App: React.FC = () => {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [running, setRunning] = useState(false);
  const [llms, setLLMs] = useState<{ name: string; active: boolean }[]>([]);
  const [convs, setConvs] = useState<ConvItem[]>([]);
  const [currentConvId, setCurrentConvId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [ask, setAsk] = useState<AskState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<InputBarHandle>(null);

  const refreshMeta = useCallback(async () => {
    setLLMs(await window.xagent.listLLMs());
    setConvs(await window.xagent.listConversations());
  }, []);

  useEffect(() => {
    refreshMeta();
    // 启动时恢复主进程当前会话
    window.xagent.getCurrentConversation().then(({ id, messages }) => {
      if (id) setCurrentConvId(id);
      if (messages && messages.length > 0) setMessages(messages);
    });
    const unsub = window.xagent.onEvent((evt) => handleEvent(evt));
    return () => unsub();
  }, [refreshMeta]);

  useEffect(() => {
    // 自动滚到底部
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [messages]);

  const handleEvent = (evt: MainEvent | any) => {
    if (evt.type === 'user-msg') {
      setMessages((prev) => [...prev, evt.msg]);
      return;
    }
    if (evt.type === 'turn_start') {
      setMessages((prev) => [
        ...prev,
        {
          id: evt.messageId,
          role: 'assistant',
          content: '',
          toolCalls: [],
          timestamp: Date.now(),
          turn: evt.turn,
          streaming: true,
        },
      ]);
      return;
    }
    if (evt.type === 'chunk') {
      setMessages((prev) =>
        prev.map((m) => (m.id === evt.messageId ? { ...m, content: m.content + evt.text } : m)),
      );
      return;
    }
    if (evt.type === 'tool_call') {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === evt.messageId
            ? { ...m, toolCalls: [...(m.toolCalls || []), { ...evt.call }] }
            : m,
        ),
      );
      return;
    }
    if (evt.type === 'tool_result') {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === evt.messageId
            ? {
                ...m,
                toolCalls: (m.toolCalls || []).map((tc) =>
                  tc.id === evt.toolCallId
                    ? { ...tc, result: evt.result, status: evt.status }
                    : tc,
                ),
              }
            : m,
        ),
      );
      return;
    }
    if (evt.type === 'turn_end') {
      setMessages((prev) =>
        prev.map((m, i, arr) => (i === arr.length - 1 ? { ...m, streaming: false } : m)),
      );
      return;
    }
    if (evt.type === 'task_done') {
      setRunning(false);
      setAsk(null);
      refreshMeta();
      return;
    }
    if (evt.type === 'error') {
      setRunning(false);
      setMessages((prev) => [
        ...prev,
        {
          id: `err_${Date.now()}`,
          role: 'assistant',
          content: `❌ ${evt.message}`,
          timestamp: Date.now(),
        },
      ]);
      return;
    }
    if (evt.type === 'ask_user') {
      setAsk({ question: evt.question, candidates: evt.candidates });
      return;
    }
  };

  const send = async (text: string) => {
    setRunning(true);
    await window.xagent.sendTask(text);
  };

  const abort = async () => {
    await window.xagent.abortTask();
    setRunning(false);
  };

  const answerAsk = async (answer: string) => {
    await window.xagent.answerAskUser(answer);
    setAsk(null);
  };

  // 统一重置到"纯净态"：中断任务、清 running/ask，避免输入框被卡
  const resetTransientState = async () => {
    try { await window.xagent.abortTask(); } catch { /* ignore */ }
    setRunning(false);
    setAsk(null);
  };

  const newConv = async () => {
    await resetTransientState();
    await window.xagent.clearHistory();
    setMessages([]);
    setCurrentConvId(null);
    refreshMeta();
    inputRef.current?.focus();
  };

  const loadConv = async (id: string) => {
    await resetTransientState();
    const msgs = await window.xagent.loadConversation(id);
    setMessages(msgs);
    setCurrentConvId(id);
    inputRef.current?.focus();
  };

  const deleteConv = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const target = convs.find((c) => c.id === id);
    setConfirm({
      title: '删除对话',
      message: `确定删除对话"${target?.title || id}"？此操作不可恢复。`,
      onConfirm: async () => {
        const ok = await window.xagent.deleteConversation(id);
        if (ok) {
          if (id === currentConvId) {
            setMessages([]);
            setCurrentConvId(null);
          }
          refreshMeta();
          inputRef.current?.focus();
        }
      },
    });
  };

  const clearAllConvs = () => {
    setConfirm({
      title: '清空历史',
      message: '确定清空全部历史对话？此操作不可恢复。',
      onConfirm: async () => {
        await window.xagent.deleteAllConversations();
        await resetTransientState();
        setMessages([]);
        setCurrentConvId(null);
        refreshMeta();
        inputRef.current?.focus();
      },
    });
  };

  const saveSettings = async (s: AppSettings) => {
    await window.xagent.saveSettings(s);
    refreshMeta();
  };

  const switchLLM = async (name: string) => {
    await window.xagent.switchLLM(name);
    refreshMeta();
  };

  const activeLLM = llms.find((l) => l.active)?.name || '';

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="logo">XAgent</div>
          <button className="btn small" onClick={newConv} title="新对话">+</button>
        </div>
        <div className="sidebar-body">
          <div className="sidebar-section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>对话历史</span>
            {convs.length > 0 && (
              <button
                className="btn small"
                style={{ fontSize: 10, padding: '2px 6px' }}
                onClick={clearAllConvs}
                title="清空全部"
              >
                清空
              </button>
            )}
          </div>
          {convs.length === 0 && (
            <div className="sidebar-item" style={{ color: 'var(--text-muted)', cursor: 'default' }}>
              暂无历史
            </div>
          )}
          {convs.map((c) => (
            <div
              key={c.id}
              className={`sidebar-item conv-item${c.id === currentConvId ? ' active' : ''}`}
              onClick={() => loadConv(c.id)}
            >
              <span className="conv-title">💬 {c.title}</span>
              <button
                className="conv-delete"
                onClick={(e) => deleteConv(c.id, e)}
                title="删除"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <div className="sidebar-footer">
          <select
            className="llm-selector"
            value={activeLLM}
            onChange={(e) => switchLLM(e.target.value)}
          >
            {llms.length === 0 && <option>未配置</option>}
            {llms.map((l) => (
              <option key={l.name} value={l.name}>{l.name}</option>
            ))}
          </select>
          <button className="btn" onClick={() => setSettingsOpen(true)}>⚙️ 设置</button>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <div className="topbar-title">
            {activeLLM ? `🤖 ${activeLLM}` : '未连接'}
          </div>
          <div className="topbar-actions">
            <button className="btn small" onClick={() => window.xagent.openDevTools()}>DevTools</button>
          </div>
        </div>

        <div className="chat-container" ref={chatRef}>
          <div className="chat-scroll">
            {messages.length === 0 && (
              <div className="empty-state" style={{ height: 400 }}>
                <h1>XAgent</h1>
                <p>桌面智能体 · 本地执行 · 多模型切换</p>
                <p style={{ fontSize: 12 }}>输入任务以开始</p>
              </div>
            )}
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}
            {ask && (
              <div className="ask-banner">
                <div className="label">等待回答</div>
                <div className="question">{ask.question}</div>
                <AskInput ask={ask} onSubmit={answerAsk} />
              </div>
            )}
          </div>
        </div>

        <InputBar ref={inputRef} running={running || !!ask} onSend={send} onAbort={abort} />
      </main>

      {settingsOpen && (
        <SettingsPanel onClose={() => setSettingsOpen(false)} onSave={saveSettings} />
      )}

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title}
        message={confirm?.message || ''}
        danger
        onCancel={() => {
          setConfirm(null);
          inputRef.current?.focus();
        }}
        onConfirm={async () => {
          const c = confirm;
          setConfirm(null);
          if (c) await c.onConfirm();
        }}
      />
    </div>
  );
};

const AskInput: React.FC<{ ask: AskState; onSubmit: (a: string) => void }> = ({ ask, onSubmit }) => {
  const [v, setV] = useState('');
  return (
    <div>
      {ask.candidates && ask.candidates.length > 0 && (
        <div className="candidates">
          {ask.candidates.map((c) => (
            <button key={c} className="btn" onClick={() => onSubmit(c)}>{c}</button>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <input
          style={{
            flex: 1,
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--border)',
            color: 'var(--text-primary)',
            padding: '6px 10px',
            borderRadius: 6,
            fontSize: 13,
          }}
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && v.trim()) onSubmit(v); }}
          placeholder="输入回答..."
          autoFocus
        />
        <button className="btn primary" onClick={() => v.trim() && onSubmit(v)}>提交</button>
      </div>
    </div>
  );
};
