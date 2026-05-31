import { useState } from 'react';

interface Props {
  onCreate: (username: string) => void;
  onJoin: (username: string, code: string) => void;
}

export function Home({ onCreate, onJoin }: Props) {
  const [username, setUsername] = useState('');
  const [code, setCode] = useState('');
  const [mode, setMode] = useState<'idle' | 'join'>('idle');

  const valid = username.trim().length > 0;

  return (
    <div className="home">
      <div className="home-card">
        <div className="logo">⚡ Jencord</div>
        <p className="subtitle">P2P screen sharing for friends</p>

        <input
          className="input"
          placeholder="Your name"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && valid && onCreate(username.trim())}
        />

        {mode === 'join' && (
          <input
            className="input"
            placeholder="Room code (e.g. WOLF-7823)"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={(e) =>
              e.key === 'Enter' && valid && code && onJoin(username.trim(), code.trim())
            }
            autoFocus
          />
        )}

        <div className="btn-row">
          <button
            className="btn btn-primary"
            disabled={!valid}
            onClick={() => onCreate(username.trim())}
          >
            Create Room
          </button>
          {mode === 'idle' ? (
            <button className="btn btn-secondary" disabled={!valid} onClick={() => setMode('join')}>
              Join Room
            </button>
          ) : (
            <button
              className="btn btn-primary"
              disabled={!valid || !code}
              onClick={() => onJoin(username.trim(), code.trim())}
            >
              Join
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
