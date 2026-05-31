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
  onStartShare: (sourceId?: string, fps?: 30 | 60) => Promise<MediaStream>;
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
  const [fps, setFps] = useState<30 | 60>(60);

  const electronAPI = (window as unknown as {
    electronAPI?: {
      getSources: () => Promise<Source[]>;
      getScreenAccess: () => Promise<string>;
    };
  }).electronAPI;

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

    try {
      if (electronAPI) {
        const access = await electronAPI.getScreenAccess();
        if (access === 'denied') {
          alert('Screen Recording permission denied.\n\nGo to System Settings → Privacy & Security → Screen Recording → enable Jencord, then restart the app.');
          return;
        }
        const srcs = await electronAPI.getSources();
        if (srcs.length === 0) {
          alert('No screens found. Grant Screen Recording permission in System Settings → Privacy & Security → Screen Recording, then restart the app.');
          return;
        }
        setSources(srcs);
      } else {
        const stream = await onStartShare(undefined, fps);
        setLocalStream(stream);
        setSharing(true);
      }
    } catch (err) {
      console.error('Screen share failed:', err);
      alert(`Screen share failed: ${err instanceof Error ? err.message : String(err)}\n\nOn macOS, check System Settings → Privacy & Security → Screen Recording.`);
    }
  }, [sharing, fps, electronAPI, onStartShare, onStopShare]);

  const pickSource = useCallback(
    async (sourceId: string) => {
      setSources(null);
      try {
        const stream = await onStartShare(sourceId, fps);
        setLocalStream(stream);
        setSharing(true);
      } catch (err) {
        console.error('Screen share failed:', err);
        alert(`Screen share failed: ${err instanceof Error ? err.message : String(err)}\n\nOn macOS, check System Settings → Privacy & Security → Screen Recording.`);
      }
    },
    [onStartShare, fps]
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
          <button
            className="btn btn-secondary"
            onClick={() => setFps(fps === 60 ? 30 : 60)}
            disabled={sharing}
            title="Toggle FPS (takes effect on next share)"
          >
            {fps} FPS
          </button>
          <button className="btn btn-danger" onClick={onLeave}>
            Leave Room
          </button>
        </div>
      </div>
    </div>
  );
}
