import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

interface Props {
  running: boolean;
  onSend: (msg: string) => void;
  onAbort: () => void;
  placeholder?: string;
}

export interface InputBarHandle {
  focus: () => void;
}

export const InputBar = forwardRef<InputBarHandle, Props>(
  ({ running, onSend, onAbort, placeholder }, externalRef) => {
    const [text, setText] = useState('');
    const ref = useRef<HTMLTextAreaElement>(null);

    // 暴露 focus 方法给父组件（用于删除会话等场景主动聚焦）
    useImperativeHandle(externalRef, () => ({
      focus: () => {
        // 原生 confirm 关闭后，先让 Electron webContents 重新获得键盘焦点，
        // 否则 DOM 焦点正确但无光标、无法输入
        window.xagent.focusWindow?.();
        // 用 rAF 等下一帧，确保 disabled 切换、DOM 更新完成
        requestAnimationFrame(() => {
          ref.current?.focus();
        });
      },
    }), []);

    // 当 running 变为 false 时，自动聚焦输入框
    useEffect(() => {
      if (!running && ref.current) {
        ref.current.focus();
      }
    }, [running]);

    const submit = () => {
      const t = text.trim();
      if (!t || running) return;
      onSend(t);
      setText('');
      if (ref.current) {
        ref.current.style.height = 'auto';
      }
    };

    const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        submit();
      }
    };

    const autoResize = (el: HTMLTextAreaElement) => {
      el.style.height = 'auto';
      el.style.height = Math.min(200, el.scrollHeight) + 'px';
    };

    return (
      <div className="input-area">
        <div className="input-container">
          <textarea
            ref={ref}
            rows={1}
            value={text}
            placeholder={placeholder || '输入任务，Enter 发送，Shift+Enter 换行'}
            onChange={(e) => {
              setText(e.target.value);
              autoResize(e.target);
            }}
            onKeyDown={handleKey}
            disabled={running}
          />
          {running ? (
            <button className="send-btn" onClick={onAbort} title="停止" style={{ background: '#f87171' }}>
              ■
            </button>
          ) : (
            <button className="send-btn" onClick={submit} disabled={!text.trim()} title="发送 (Enter)">
              ↑
            </button>
          )}
        </div>
        <div className="status-bar">
          <span className={`dot ${running ? 'running' : ''}`}></span>
          <span>{running ? '思考中...' : '就绪'}</span>
        </div>
      </div>
    );
  },
);

InputBar.displayName = 'InputBar';
