import { useState, useCallback } from 'react';
import { VideoTile } from './VideoTile';
import { Chat } from './Chat';
import type { ChatMessage, Peer } from './types';

interface Source {
  id: string;
  name: string;
  thumbnail: string;
}

interface Props {
  roomCode: string;
  username: string;
  peers: Map<string, Peer>;
  messages: ChatMessage[];
  onSend: (text: string) => void;
  onLeave: () => void;
  onStartShare: (sourceId?: string) => Promise<MediaStream>;
  onStopShare: () => void;
}

export function Room({
  roomCode,
  username,
  peers,
  messages,
  onSend,
  onLeave,
  onStartShare,
  onStopShare,
}: Props) {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [sharing, setSharing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [sources, setSources] = useState<Source[] | null>(null);

  const electronAPI = (window as unknown as { electronAPI?: { getSources: () => Promise<Source[]> } })
    .electronAPI;

  const copyCode = () => {
    navigator.clipboard.writeText(roomCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleShare = useCallback(async () => {
    if (sharing) {
      onStopShare();
      setLocalStream(null);
      setSharing(false);
      return;
    }

    if (electronAPI) {
      const srcs = await electronAPI.getSources();
      setSources(srcs);
    } else {
      const stream = await onStartShare();
      setLocalStream(stream);
      setSharing(true);
    }
  }, [sharing, electronAPI, onStartShare, onStopShare]);

  const pickSource = useCallback(
    async (sourceId: string) => {
      setSources(null);
      const stream = await onStartShare(sourceId);
      setLocalStream(stream);
      setSharing(true);
    },
    [onStartShare]
  );

  const allTiles = [
    { id: 'me', username, stream: localStream ?? undefined },
    ...Array.from(peers.values()),
  ];

  return (
    <div className="room">
      {sources && (
        <div className="modal-overlay" onClick={() => setSources(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Choose what to share</h3>
            <div className="sources-grid">
              {sources.map((s) => (
                <div key={s.id} className="source-item" onClick={() => pickSource(s.id)}>
                  <img src={s.thumbnail} alt={s.name} />
                  <span>{s.name}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="room-sidebar">
        <div className="room-header">
          <span className="logo-sm">⚡ Jencord</span>
        </div>
        <div className="room-code-block">
          <span className="room-code-label">Room Code</span>
          <div className="room-code-row">
            <span className="room-code">{roomCode}</span>
            <button className="btn-icon" onClick={copyCode} title="Copy">
              {copied ? '✓' : '⎘'}
            </button>
          </div>
          <span className="room-hint">Share this with friends</span>
        </div>
        <div className="peers-list">
          <div className="peers-label">In room ({peers.size + 1})</div>
          <div className="peer-item">
            <span className="avatar-sm">{username[0].toUpperCase()}</span>
            {username} (you)
          </div>
          {Array.from(peers.values()).map((p) => (
            <div key={p.id} className="peer-item">
              <span className="avatar-sm">{p.username[0].toUpperCase()}</span>
              {p.username}
            </div>
          ))}
        </div>
        <Chat messages={messages} onSend={onSend} />
      </div>

      <div className="room-main">
        <div className={`video-grid tiles-${allTiles.length}`}>
          {allTiles.map((t) => (
            <VideoTile key={t.id} stream={t.stream} label={t.username} muted={t.id === 'me'} />
          ))}
        </div>

        <div className="toolbar">
          <button
            className={`btn ${sharing ? 'btn-danger' : 'btn-primary'}`}
            onClick={handleShare}
          >
            {sharing ? 'Stop Sharing' : 'Share Screen'}
          </button>
          <button className="btn btn-danger" onClick={onLeave}>
            Leave Room
          </button>
        </div>
      </div>
    </div>
  );
}
