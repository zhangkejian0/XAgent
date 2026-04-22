import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ToolCallCard } from './ToolCallCard';
import type { UIMessage } from '@shared/types';

export const MessageBubble: React.FC<{ message: UIMessage }> = ({ message }) => {
  if (message.role === 'user') {
    return (
      <div className="message user">
        <div className="msg-avatar">我</div>
        <div className="msg-body">
          <div className="msg-bubble">{message.content}</div>
        </div>
      </div>
    );
  }

  // assistant
  const processedContent = processContentTags(message.content);

  return (
    <div className="message assistant">
      <div className="msg-avatar">X</div>
      <div className="msg-body">
        <div className="msg-content">
          {processedContent.thinking && (
            <div className="thinking">💭 {processedContent.thinking}</div>
          )}
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{processedContent.body}</ReactMarkdown>
          {processedContent.summary && (
            <div className="summary">📌 {processedContent.summary}</div>
          )}
          {message.toolCalls?.map((tc) => (
            <ToolCallCard
              key={tc.id}
              id={tc.id}
              name={tc.name}
              args={tc.args}
              result={tc.result}
              status={tc.status}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

function processContentTags(raw: string): {
  body: string;
  thinking?: string;
  summary?: string;
} {
  let body = raw || '';
  let thinking: string | undefined;
  let summary: string | undefined;

  const think = body.match(/<thinking>([\s\S]*?)<\/thinking>/);
  if (think) {
    thinking = think[1].trim();
    body = body.replace(think[0], '');
  }
  const sum = body.match(/<summary>([\s\S]*?)<\/summary>/);
  if (sum) {
    summary = sum[1].trim();
    body = body.replace(sum[0], '');
  }
  return { body: body.trim(), thinking, summary };
}
