import React, { useRef, useState } from 'react';

interface Props {
  running: boolean;
  onSend: (msg: string) => void;
  onAbort: () => void;
  placeholder?: string;
}

export const InputBar: React.FC<Props> = ({ running, onSend, onAbort, placeholder }) => {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

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
};
