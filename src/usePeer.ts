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

export function usePeer(username: string) {
  const peerRef = useRef<Peer | null>(null);
  const dataConns = useRef<Map<string, DataConnection>>(new Map());
  const mediaConns = useRef<Map<string, MediaConnection>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);

  const [myId, setMyId] = useState('');
  const [peers, setPeers] = useState<Map<string, PeerInfo>>(new Map());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inRoom, setInRoom] = useState(false);
  const [micEnabled, setMicEnabled] = useState(false);

  const addMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const updatePeerStream = useCallback((id: string, stream: MediaStream) => {
    setPeers((prev) => {
      const next = new Map(prev);
      const existing = next.get(id) ?? { id, username: id };
      next.set(id, { ...existing, stream });
      return next;
    });
  }, []);

  const addPeer = useCallback((id: string, uname: string) => {
    setPeers((prev) => {
      const next = new Map(prev);
      if (!next.has(id)) next.set(id, { id, username: uname });
      return next;
    });
  }, []);

  const removePeer = useCallback((id: string) => {
    setPeers((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    dataConns.current.delete(id);
    mediaConns.current.delete(id);
  }, []);

  function broadcast(data: object) {
    dataConns.current.forEach((conn) => conn.send(data));
  }

  function handleDataConn(conn: DataConnection) {
    dataConns.current.set(conn.peer, conn);
    conn.on('data', (raw) => {
      const data = raw as { type: string; [key: string]: unknown };
      if (data.type === 'chat') {
        addMessage(data.msg as ChatMessage);
      } else if (data.type === 'hello') {
        addPeer(conn.peer, data.username as string);
      }
    });
    conn.on('close', () => removePeer(conn.peer));
  }

  function callPeer(peerId: string, stream: MediaStream) {
    if (!peerRef.current) return;
    const call = peerRef.current.call(peerId, stream, {
      metadata: { username },
    });
    mediaConns.current.set(peerId, call);
    call.on('stream', (remote) => updatePeerStream(peerId, remote));
    call.on('close', () => removePeer(peerId));
  }

  function initPeer(roomCode: string) {
    const peer = new Peer(roomCode);
    peerRef.current = peer;

    peer.on('open', (id) => {
      setMyId(id);
      setInRoom(true);
    });

    peer.on('connection', (conn) => {
      conn.on('open', () => {
        handleDataConn(conn);
        conn.send({ type: 'hello', username });
        // Call them back with our stream if we have one
        if (localStreamRef.current) {
          callPeer(conn.peer, localStreamRef.current);
        }
      });
    });

    peer.on('call', (call) => {
      addPeer(call.peer, call.metadata?.username ?? call.peer);
      mediaConns.current.set(call.peer, call);
      call.answer(localStreamRef.current ?? undefined);
      call.on('stream', (remote) => updatePeerStream(call.peer, remote));
      call.on('close', () => removePeer(call.peer));
    });

    peer.on('error', (err) => console.error('PeerJS error:', err));
  }

  const createRoom = useCallback(() => {
    const code = randomCode();
    initPeer(code);
    return code;
  }, [username]);

  const joinRoom = useCallback(
    (code: string) => {
      const trimmed = code.trim().toUpperCase();
      // Use a random ID for joiner, connect to host
      const joinerId = `${trimmed}-${Math.random().toString(36).slice(2, 6)}`;
      const peer = new Peer(joinerId);
      peerRef.current = peer;

      peer.on('open', (id) => {
        setMyId(id);
        setInRoom(true);
        const conn = peer.connect(trimmed, { metadata: { username } });
        conn.on('open', () => {
          handleDataConn(conn);
          conn.send({ type: 'hello', username });
          addPeer(trimmed, trimmed);
          if (localStreamRef.current) {
            callPeer(trimmed, localStreamRef.current);
          }
        });
      });

      peer.on('connection', (conn) => {
        conn.on('open', () => {
          handleDataConn(conn);
          conn.send({ type: 'hello', username });
          if (localStreamRef.current) {
            callPeer(conn.peer, localStreamRef.current);
          }
        });
      });

      peer.on('call', (call) => {
        addPeer(call.peer, call.metadata?.username ?? call.peer);
        mediaConns.current.set(call.peer, call);
        call.answer(localStreamRef.current ?? undefined);
        call.on('stream', (remote) => updatePeerStream(call.peer, remote));
        call.on('close', () => removePeer(call.peer));
      });

      peer.on('error', (err) => console.error('PeerJS error:', err));
    },
    [username]
  );

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
          },
        },
      });
    } else {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: fps, max: fps }, width: 1920, height: 1080 },
        audio: false,
      });
    }

    localStreamRef.current = stream;

    const outbound = buildOutboundStream()!;
    dataConns.current.forEach((_, peerId) => callPeer(peerId, outbound));

    return stream;
  }, []);

  const stopScreenShare = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
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
      dataConns.current.forEach((_, peerId) => callPeer(peerId, outbound));
    }
  }, []);

  const sendMessage = useCallback(
    (text: string) => {
      const msg: ChatMessage = {
        id: crypto.randomUUID(),
        user: username,
        text,
        timestamp: Date.now(),
      };
      addMessage(msg);
      broadcast({ type: 'chat', msg });
    },
    [username, addMessage]
  );

  const leaveRoom = useCallback(() => {
    stopScreenShare();
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    peerRef.current?.destroy();
    peerRef.current = null;
    dataConns.current.clear();
    mediaConns.current.clear();
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
