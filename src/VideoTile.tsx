import { useEffect, useRef } from 'react';

interface Props {
  stream?: MediaStream;
  label: string;
  muted?: boolean;
  soundMuted?: boolean;
}

export function VideoTile({ stream, label, muted = false, soundMuted = false }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const tileRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted || soundMuted;
  }, [muted, soundMuted]);

  function handleFullscreen(e: React.MouseEvent) {
    // Tile and button both listen; stop the bubble so we don't fire twice
    // (two requestFullscreen calls in one tick → "Permissions check failed").
    e.stopPropagation();
    const el = tileRef.current;
    if (!el) return;
    // Only exit if THIS tile is the fullscreen element; otherwise switch to it.
    if (document.fullscreenElement === el) {
      document.exitFullscreen().catch((err) => console.error('exitFullscreen', err));
    } else {
      el.requestFullscreen().catch((err) => console.error('requestFullscreen', err));
    }
  }

  return (
    <div className="video-tile" ref={tileRef} onClick={handleFullscreen}>
      {stream ? (
        <video ref={videoRef} autoPlay playsInline muted={muted || soundMuted} />
      ) : (
        <div className="video-placeholder">
          <span className="avatar">{label[0].toUpperCase()}</span>
        </div>
      )}
      <div className="video-label">{label}</div>
      <button className="tile-fullscreen-btn" onClick={handleFullscreen} title="Fullscreen">⛶</button>
    </div>
  );
}
