import { useState, useEffect, useRef } from 'react';
import type { ChatMessage } from './types';

interface Props {
  messages: ChatMessage[];
  onSend: (text: string) => void;
}

export function Chat({ messages, onSend }: Props) {
  const [text, setText] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function send() {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText('');
  }

  return (
    <div className="chat">
      <div className="chat-header">Chat</div>
      <div className="chat-messages">
        {messages.map((m) => (
          <div key={m.id} className="chat-msg">
            <span className="chat-user">{m.user}</span>
            <span className="chat-text">{m.text}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="chat-input-row">
        <input
          className="input"
          placeholder="Message..."
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
        />
        <button className="btn btn-primary" onClick={send}>
          Send
        </button>
      </div>
    </div>
  );
}
