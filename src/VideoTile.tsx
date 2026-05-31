import { useEffect, useRef } from 'react';

interface Props {
  stream?: MediaStream;
  label: string;
  muted?: boolean;
}

export function VideoTile({ stream, label, muted = false }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <div className="video-tile">
      {stream ? (
        <video ref={videoRef} autoPlay playsInline muted={muted} />
      ) : (
        <div className="video-placeholder">
          <span className="avatar">{label[0].toUpperCase()}</span>
        </div>
      )}
      <div className="video-label">{label}</div>
    </div>
  );
}
