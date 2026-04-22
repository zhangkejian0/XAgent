import React, { useState } from 'react';

export interface ToolCallProps {
  id: string;
  name: string;
  args: Record<string, any>;
  result?: string;
  status: 'pending' | 'running' | 'success' | 'error';
}

function shortSummary(name: string, args: Record<string, any>): string {
  if (name === 'file_read' || name === 'file_write' || name === 'file_patch') {
    return args.path || '';
  }
  if (name === 'code_run') {
    const script = args.script || args.code || '';
    return `${args.type || 'python'} · ${script.slice(0, 50).replace(/\n/g, ' ')}${script.length > 50 ? '...' : ''}`;
  }
  if (name === 'web_scan') return args.url || '当前标签';
  if (name === 'web_execute_js') {
    const s = args.script || '';
    return `${s.slice(0, 60).replace(/\n/g, ' ')}${s.length > 60 ? '...' : ''}`;
  }
  if (name === 'ask_user') return args.question || '';
  if (name === 'update_working_checkpoint') return args.key_info || '';
  if (name === 'start_long_term_update') return '整理长期记忆';
  return JSON.stringify(args).slice(0, 80);
}

export const ToolCallCard: React.FC<ToolCallProps> = ({ name, args, result, status }) => {
  const [open, setOpen] = useState(false);
  const summary = shortSummary(name, args);

  const statusText: Record<string, string> = {
    pending: '...',
    running: '⟳',
    success: '✓',
    error: '✗',
  };

  return (
    <div className="tool-card">
      <div className="tool-header" onClick={() => setOpen((o) => !o)}>
        <span className={`tool-icon ${status}`}>{statusText[status]}</span>
        <span className="tool-name">{name}</span>
        <span className="tool-summary">{summary}</span>
      </div>
      {open && (
        <div className="tool-body">
          <div className="tool-args">Args: {JSON.stringify(args, null, 2)}</div>
          <pre>{result ?? '(执行中...)'}</pre>
        </div>
      )}
    </div>
  );
};
