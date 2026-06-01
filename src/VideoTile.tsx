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

  function handleFullscreen() {
    const el = videoRef.current ?? tileRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      el.requestFullscreen();
    }
  }

  return (
    <div className="video-tile" ref={tileRef} onDoubleClick={handleFullscreen}>
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
