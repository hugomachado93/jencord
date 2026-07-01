import { useEffect, useRef, useState, useCallback } from 'react';
import Peer from 'peerjs';
import type { DataConnection, MediaConnection } from 'peerjs';
import type { ChatMessage, Peer as PeerInfo } from './types';

function randomCode() {
  const words = ['WOLF', 'HAWK', 'BEAR', 'LION', 'FOX', 'OWL', 'LYNX', 'JADE'];
  const word = words[Math.floor(Math.random() * words.length)];
  const num = Math.floor(1000 + Math.random() * 9000);
  return `${word}-${num}`;
}

function pc(call: MediaConnection): RTCPeerConnection {
  return (call as unknown as { peerConnection: RTCPeerConnection }).peerConnection;
}

export function usePeer(username: string) {
  const peerRef = useRef<Peer | null>(null);
  const dataConns = useRef<Map<string, DataConnection>>(new Map());
  const mediaConns = useRef<Map<string, MediaConnection>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const peerNames = useRef<Map<string, string>>(new Map());

  // Keep latest username available inside long-lived event callbacks.
  const usernameRef = useRef(username);
  usernameRef.current = username;
  const myIdRef = useRef('');

  const [myId, setMyId] = useState('');
  const [peers, setPeers] = useState<Map<string, PeerInfo>>(new Map());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inRoom, setInRoom] = useState(false);
  const [micEnabled, setMicEnabled] = useState(false);

  const addMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const updatePeerStream = useCallback((id: string, stream: MediaStream | undefined) => {
    setPeers((prev) => {
      const next = new Map(prev);
      const existing = next.get(id) ?? { id, username: peerNames.current.get(id) ?? id };
      next.set(id, { ...existing, stream });
      return next;
    });
  }, []);

  const addPeer = useCallback((id: string, uname: string) => {
    peerNames.current.set(id, uname);
    setPeers((prev) => {
      const next = new Map(prev);
      const existing = next.get(id);
      next.set(id, { ...existing, id, username: uname });
      return next;
    });
  }, []);

  // Peer actually left (data connection closed) — drop them entirely.
  const removePeer = useCallback((id: string) => {
    peerNames.current.delete(id);
    setPeers((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    dataConns.current.delete(id);
    mediaConns.current.get(id)?.close();
    mediaConns.current.delete(id);
  }, []);

  function broadcast(data: object) {
    dataConns.current.forEach((conn) => conn.send(data));
  }

  function rosterList(exclude?: string) {
    return Array.from(dataConns.current.keys())
      .filter((id) => id !== exclude)
      .map((id) => ({ id, username: peerNames.current.get(id) ?? id }));
  }

  function handleDataConn(conn: DataConnection) {
    dataConns.current.set(conn.peer, conn);
    conn.on('data', (raw) => {
      const data = raw as { type: string; [key: string]: unknown };
      if (data.type === 'chat') {
        addMessage(data.msg as ChatMessage);
      } else if (data.type === 'hello') {
        addPeer(conn.peer, data.username as string);
      } else if (data.type === 'roster') {
        // Discover everyone else in the room and dial the ones we should.
        const list = data.peers as { id: string; username: string }[];
        for (const p of list) {
          if (p.id === myIdRef.current) continue;
          peerNames.current.set(p.id, p.username);
          addPeer(p.id, p.username);
          connectToPeer(p.id);
        }
      } else if (data.type === 'request-call') {
        // A peer that has no stream wants ours.
        const outbound = buildOutboundStream();
        if (outbound) updateOutboundForPeer(conn.peer, outbound);
      }
    });
    conn.on('close', () => removePeer(conn.peer));
  }

  function applyGameStreamingParams(call: MediaConnection) {
    const conn = pc(call);
    const apply = async () => {
      for (const sender of conn.getSenders()) {
        if (sender.track?.kind !== 'video') continue;
        const params = sender.getParameters();
        if (!params.encodings?.length) params.encodings = [{}];
        params.degradationPreference = 'maintain-framerate';
        params.encodings[0].maxBitrate = 12_000_000;
        params.encodings[0].priority = 'high';
        await sender.setParameters(params).catch(() => {});
      }
    };
    if (conn.connectionState === 'connected') {
      apply();
    } else {
      conn.addEventListener('connectionstatechange', () => {
        if (conn.connectionState === 'connected') apply();
      });
    }
  }

  // Diagnostic: logs what the encoder is actually doing every 2s.
  // encoderImplementation reveals hardware vs software; qualityLimitationReason
  // tells us whether stutter is CPU-bound or bandwidth-bound.
  function logSenderStats(call: MediaConnection) {
    const conn = pc(call);
    const timer = setInterval(async () => {
      if (conn.connectionState === 'closed') { clearInterval(timer); return; }
      const stats = await conn.getStats();
      stats.forEach((r) => {
        if (r.type === 'outbound-rtp' && r.kind === 'video') {
          const codec = stats.get(r.codecId as string);
          console.log('[stream]', {
            codec: codec?.mimeType,
            encoder: r.encoderImplementation,      // e.g. hardware name vs "libvpx"/"OpenH264"
            fps: r.framesPerSecond,
            res: `${r.frameWidth}x${r.frameHeight}`,
            limited: r.qualityLimitationReason,     // "cpu" | "bandwidth" | "none"
            kbps: r.bytesSent ? Math.round((r.bytesSent * 8) / 1000) : 0,
          });
        }
      });
    }, 2000);
    conn.addEventListener('connectionstatechange', () => {
      if (conn.connectionState === 'closed') clearInterval(timer);
    });
  }

  function preferH264(call: MediaConnection) {
    const conn = pc(call);
    const caps = RTCRtpSender.getCapabilities?.('video');
    if (!caps) return;
    const order = ['video/H264', 'video/VP9', 'video/VP8'];
    const rank = (mime: string) => { const i = order.indexOf(mime); return i === -1 ? 999 : i; };
    const sorted = [...caps.codecs].sort((a, b) => rank(a.mimeType) - rank(b.mimeType));
    for (const t of conn.getTransceivers()) {
      if (t.sender.track?.kind === 'video') {
        try { t.setCodecPreferences(sorted); } catch { /* browser may reject */ }
      }
    }
  }

  // Wire stream/close handlers shared by outgoing calls and answered calls.
  function wireMediaConn(peerId: string, call: MediaConnection) {
    call.on('stream', (remote) => updatePeerStream(peerId, remote));
    call.on('close', () => {
      // Media stopped — but the peer is still in the room (data conn lives).
      if (mediaConns.current.get(peerId) === call) {
        mediaConns.current.delete(peerId);
        updatePeerStream(peerId, undefined);
      }
    });
  }

  function callPeer(peerId: string, stream: MediaStream) {
    if (!peerRef.current) return;
    const call = peerRef.current.call(peerId, stream, {
      metadata: { username: usernameRef.current },
    });
    mediaConns.current.set(peerId, call);
    preferH264(call);
    applyGameStreamingParams(call);
    logSenderStats(call);
    wireMediaConn(peerId, call);
  }

  async function updateOutboundForPeer(peerId: string, stream: MediaStream) {
    const existing = mediaConns.current.get(peerId);
    if (!existing) {
      callPeer(peerId, stream);
      return;
    }
    const conn = pc(existing);
    const senders = conn.getSenders().filter((s) => s.track);
    const newTracks = stream.getTracks();
    const needsNewKind = newTracks.some((t) => !senders.find((s) => s.track?.kind === t.kind));
    if (needsNewKind) {
      // Can't add a track kind without renegotiation PeerJS doesn't expose — redial.
      existing.close();
      mediaConns.current.delete(peerId);
      callPeer(peerId, stream);
      return;
    }
    for (const sender of senders) {
      const replacement = newTracks.find((t) => t.kind === sender.track!.kind) ?? null;
      await sender.replaceTrack(replacement);
    }
  }

  // Drop only the video track from every peer (stop-share with mic still on/off).
  async function removeVideoFromPeers() {
    for (const call of mediaConns.current.values()) {
      for (const sender of pc(call).getSenders()) {
        if (sender.track?.kind === 'video') await sender.replaceTrack(null).catch(() => {});
      }
    }
  }

  function connectToPeer(id: string) {
    if (!peerRef.current) return;
    // Lower id dials higher id — avoids both sides opening duplicate conns.
    if (id === myIdRef.current || dataConns.current.has(id) || myIdRef.current >= id) return;
    const conn = peerRef.current.connect(id, { metadata: { username: usernameRef.current } });
    conn.on('open', () => onDataOpen(conn));
  }

  function onDataOpen(conn: DataConnection) {
    handleDataConn(conn);
    conn.send({ type: 'hello', username: usernameRef.current });
    conn.send({ type: 'roster', peers: rosterList(conn.peer) });
    // Tell everyone else this newcomer exists so the mesh fills in.
    broadcast({ type: 'roster', peers: rosterList() });

    const outbound = buildOutboundStream();
    if (outbound) {
      updateOutboundForPeer(conn.peer, outbound);
    } else if (myIdRef.current >= conn.peer) {
      // We can't initiate (no stream) and we're the higher id — ask them to call us.
      conn.send({ type: 'request-call' });
    }
  }

  function handleIncomingCall(call: MediaConnection) {
    const peerId = call.peer;
    const existing = mediaConns.current.get(peerId);
    if (existing) {
      // Glare: keep the connection initiated by the lower id.
      if (myIdRef.current < peerId) {
        call.close();
        return;
      }
      existing.close();
    }
    addPeer(peerId, (call.metadata?.username as string) ?? peerNames.current.get(peerId) ?? peerId);
    mediaConns.current.set(peerId, call);
    call.answer(buildOutboundStream() ?? undefined);
    preferH264(call);
    applyGameStreamingParams(call);
    logSenderStats(call);
    wireMediaConn(peerId, call);
  }

  function setupPeer(peer: Peer, onOpen?: (id: string) => void) {
    peerRef.current = peer;
    peer.on('open', (id) => {
      myIdRef.current = id;
      setMyId(id);
      setInRoom(true);
      onOpen?.(id);
    });
    peer.on('connection', (conn) => conn.on('open', () => onDataOpen(conn)));
    peer.on('call', handleIncomingCall);
    peer.on('error', (err) => console.error('PeerJS error:', err));
  }

  const createRoom = useCallback((name: string) => {
    usernameRef.current = name;
    const code = randomCode();
    setupPeer(new Peer(code));
    return code;
  }, []);

  const joinRoom = useCallback((name: string, code: string) => {
    usernameRef.current = name;
    const trimmed = code.trim().toUpperCase();
    const joinerId = `${trimmed}-${Math.random().toString(36).slice(2, 6)}`;
    setupPeer(new Peer(joinerId), () => {
      const conn = peerRef.current!.connect(trimmed, { metadata: { username: name } });
      conn.on('open', () => onDataOpen(conn));
    });
  }, []);

  const startScreenShare = useCallback(async (sourceId?: string, fps: 30 | 60 = 60) => {
    let stream: MediaStream;

    if (sourceId && (window as unknown as { electronAPI?: { getSources: () => Promise<unknown[]> } }).electronAPI) {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          // @ts-expect-error Electron-specific constraint
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId,
            maxFrameRate: fps,
            maxWidth: 1920,
            maxHeight: 1080,
          },
        },
      });
    } else {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: fps, max: fps }, width: 1920, height: 1080 },
        audio: false,
      });
    }

    const videoTrack = stream.getVideoTracks()[0];
    // Tell the encoder to prioritise smooth motion over per-frame detail — critical for games.
    if (videoTrack) videoTrack.contentHint = 'motion';
    // OS-level "stop sharing" button — clean up so peers stop seeing a frozen frame.
    videoTrack?.addEventListener('ended', () => stopScreenShare());

    localStreamRef.current = stream;

    const outbound = buildOutboundStream()!;
    dataConns.current.forEach((_, peerId) => updateOutboundForPeer(peerId, outbound));

    return stream;
  }, []);

  const stopScreenShare = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    const outbound = buildOutboundStream();
    if (outbound) {
      // Mic still on: keep the audio, drop the video.
      dataConns.current.forEach((_, peerId) => updateOutboundForPeer(peerId, outbound));
    } else {
      removeVideoFromPeers();
    }
  }, []);

  function buildOutboundStream(): MediaStream | null {
    const tracks: MediaStreamTrack[] = [];
    if (localStreamRef.current) tracks.push(...localStreamRef.current.getVideoTracks());
    if (micStreamRef.current) tracks.push(...micStreamRef.current.getAudioTracks());
    return tracks.length > 0 ? new MediaStream(tracks) : null;
  }

  const toggleMic = useCallback(async () => {
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
      setMicEnabled(false);
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      micStreamRef.current = stream;
      setMicEnabled(true);
    }
    const outbound = buildOutboundStream();
    if (outbound) {
      dataConns.current.forEach((_, peerId) => updateOutboundForPeer(peerId, outbound));
    } else {
      // Mic was the only track and it's now off — drop audio senders.
      for (const call of mediaConns.current.values()) {
        for (const sender of pc(call).getSenders()) {
          if (sender.track?.kind === 'audio') await sender.replaceTrack(null).catch(() => {});
        }
      }
    }
  }, []);

  const sendMessage = useCallback((text: string) => {
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      user: usernameRef.current,
      text,
      timestamp: Date.now(),
    };
    addMessage(msg);
    broadcast({ type: 'chat', msg });
  }, [addMessage]);

  const leaveRoom = useCallback(() => {
    stopScreenShare();
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    peerRef.current?.destroy();
    peerRef.current = null;
    dataConns.current.clear();
    mediaConns.current.clear();
    peerNames.current.clear();
    myIdRef.current = '';
    setPeers(new Map());
    setMessages([]);
    setInRoom(false);
    setMyId('');
  }, [stopScreenShare]);

  useEffect(() => () => { peerRef.current?.destroy(); }, []);

  return {
    myId,
    peers,
    messages,
    inRoom,
    micEnabled,
    createRoom,
    joinRoom,
    startScreenShare,
    stopScreenShare,
    toggleMic,
    sendMessage,
    leaveRoom,
  };
}
