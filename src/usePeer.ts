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
        // 8 Mbps, not 12: sustained 12 saturated link buffers, spiking rtt and
        // making congestion control oscillate (resolution flapped 1080<->720).
        // 8 gives the controller headroom, so it holds full resolution steadily.
        params.encodings[0].maxBitrate = 8_000_000;
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

  // Diagnostic: logs what the encoder + network are actually doing every 2s.
  // Reports rates as deltas (not cumulative totals) and a one-line verdict that
  // separates the three failure modes: CPU-bound, bandwidth-bound, network loss.
  function logSenderStats(call: MediaConnection) {
    const conn = pc(call);
    const peerLabel = peerNames.current.get(call.peer) ?? call.peer;
    // Previous sample, for delta math.
    let prev: {
      t: number; bytesSent: number; framesEncoded: number;
      totalEncodeTime: number; packetsLost: number; nackCount: number; pliCount: number;
    } | null = null;

    const timer = setInterval(async () => {
      if (conn.connectionState === 'closed') { clearInterval(timer); return; }
      const stats = await conn.getStats();

      let out: any = null;
      let remoteIn: any = null;
      let candidatePair: any = null;
      stats.forEach((r) => {
        if (r.type === 'outbound-rtp' && r.kind === 'video') out = r;
        else if (r.type === 'remote-inbound-rtp' && r.kind === 'video') remoteIn = r;
        else if (r.type === 'candidate-pair' && (r.nominated || r.state === 'succeeded')) {
          // Prefer the pair actually carrying bytes.
          if (!candidatePair || (r.bytesSent ?? 0) > (candidatePair.bytesSent ?? 0)) candidatePair = r;
        }
      });
      if (!out) return;

      const now = performance.now();
      const codec = stats.get(out.codecId as string);

      // --- deltas ---
      let sendKbps = 0, encMsPerFrame = 0, lostDelta = 0, nackDelta = 0, pliDelta = 0, encFps = 0;
      if (prev) {
        const dt = (now - prev.t) / 1000;
        sendKbps = Math.round(((out.bytesSent - prev.bytesSent) * 8) / 1000 / dt);
        const dFrames = out.framesEncoded - prev.framesEncoded;
        encFps = Math.round(dFrames / dt);
        encMsPerFrame = dFrames > 0
          ? Math.round(((out.totalEncodeTime - prev.totalEncodeTime) / dFrames) * 1000)
          : 0;
        lostDelta = (out.packetsLost ?? remoteIn?.packetsLost ?? 0) - prev.packetsLost;
        nackDelta = (out.nackCount ?? 0) - prev.nackCount;
        pliDelta = (out.pliCount ?? 0) - prev.pliCount;
      }
      prev = {
        t: now,
        bytesSent: out.bytesSent ?? 0,
        framesEncoded: out.framesEncoded ?? 0,
        totalEncodeTime: out.totalEncodeTime ?? 0,
        packetsLost: (out.packetsLost ?? remoteIn?.packetsLost ?? 0),
        nackCount: out.nackCount ?? 0,
        pliCount: out.pliCount ?? 0,
      };

      const encoder: string = out.encoderImplementation ?? '?';
      // Hardware encoders name a vendor/API or an "Accelerator"; software is libvpx/OpenH264/libaom.
      const isHardware = !/libvpx|openh264|libaom|software|fallback/i.test(encoder)
        && /nvidia|nvenc|mediafoundation|mft|amf|qualcomm|quicksync|intel|videotoolbox|mediacodec|d3d|dxva|vaapi|hardware|accelerator|external/i.test(encoder);
      const targetKbps = out.targetBitrate ? Math.round(out.targetBitrate / 1000) : 0;
      const availKbps = candidatePair?.availableOutgoingBitrate
        ? Math.round(candidatePair.availableOutgoingBitrate / 1000) : 0;
      const rttMs = Math.round(
        ((candidatePair?.currentRoundTripTime ?? remoteIn?.roundTripTime ?? 0)) * 1000,
      );
      const lossPct = remoteIn?.fractionLost != null ? Math.round(remoteIn.fractionLost * 100) : undefined;
      const reason: string = out.qualityLimitationReason ?? 'none';

      // --- verdict: what's actually throttling us ---
      let verdict = 'ok';
      if (reason === 'cpu' || (!isHardware && encMsPerFrame > 16)) {
        verdict = `⚠️ CPU-bound (encode ${encMsPerFrame}ms/frame${isHardware ? '' : ', SOFTWARE encoder'})`;
      } else if (reason === 'bandwidth' || (availKbps && sendKbps > availKbps * 0.9)) {
        verdict = `⚠️ BANDWIDTH-bound (sending ${sendKbps}k, link allows ~${availKbps || '?'}k)`;
      } else if (lostDelta > 0 || pliDelta > 0) {
        verdict = `⚠️ NETWORK loss (${lostDelta} pkts, ${pliDelta} keyframe-requests, rtt ${rttMs}ms)`;
      } else if (encFps > 0 && encFps < 24) {
        verdict = `⚠️ low fps ${encFps} (not cpu/bw limited — check source frameRate)`;
      }

      console.log(
        `[stream ${peerLabel}] ${verdict}`,
        {
          codec: (codec?.mimeType ?? '?').replace('video/', ''),
          encoder,
          hw: isHardware,
          fps: out.framesPerSecond ?? encFps,
          res: `${out.frameWidth}x${out.frameHeight}`,
          sendKbps,
          targetKbps,
          availKbps,
          limited: reason,
          encodeMsPerFrame: encMsPerFrame,
          lostΔ: lostDelta,
          nackΔ: nackDelta,
          pliΔ: pliDelta,
          lossPct,
          rttMs,
        },
      );
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

  // The real codec fix: setCodecPreferences runs after PeerJS has already built
  // the offer, so it's too late. sdpTransform rewrites the SDP *before* it's sent —
  // we promote H264's payload types to the front of the video m-line so H264 wins
  // negotiation and Chromium can use a hardware encoder instead of software VP8.
  function preferH264Sdp(sdp: string): string {
    const lines = sdp.split('\r\n');
    const mIdx = lines.findIndex((l) => l.startsWith('m=video'));
    if (mIdx === -1) return sdp;
    const h264Pts: string[] = [];
    for (const l of lines) {
      const m = l.match(/^a=rtpmap:(\d+)\s+H264\/90000/i);
      if (m) h264Pts.push(m[1]);
    }
    if (!h264Pts.length) return sdp;
    const parts = lines[mIdx].split(' ');
    const header = parts.slice(0, 3);            // "m=video", port, proto
    const pts = parts.slice(3);                  // payload-type list
    const reordered = [...h264Pts, ...pts.filter((p) => !h264Pts.includes(p))];
    lines[mIdx] = [...header, ...reordered].join(' ');
    return lines.join('\r\n');
  }

  // Receiver-side diagnostic: what the DECODER is doing every 2s. Sender stats
  // can look perfect while the viewer drops frames — this is the other half.
  // framesDropped + decode time reveal a CPU-bound decoder; packet loss / freezes
  // reveal a network problem on the downlink.
  function logReceiverStats(call: MediaConnection) {
    const conn = pc(call);
    const peerLabel = peerNames.current.get(call.peer) ?? call.peer;
    let prev: {
      t: number; framesDecoded: number; framesDropped: number;
      totalDecodeTime: number; packetsLost: number; freezeCount: number; bytesReceived: number;
    } | null = null;

    const timer = setInterval(async () => {
      if (conn.connectionState === 'closed') { clearInterval(timer); return; }
      const stats = await conn.getStats();
      let inb: any = null;
      stats.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') inb = r; });
      if (!inb) return;

      const now = performance.now();
      const codec = stats.get(inb.codecId as string);

      let recvKbps = 0, decFps = 0, decMsPerFrame = 0, droppedDelta = 0, lostDelta = 0, freezeDelta = 0;
      if (prev) {
        const dt = (now - prev.t) / 1000;
        recvKbps = Math.round(((inb.bytesReceived - prev.bytesReceived) * 8) / 1000 / dt);
        const dFrames = inb.framesDecoded - prev.framesDecoded;
        decFps = Math.round(dFrames / dt);
        decMsPerFrame = dFrames > 0
          ? Math.round(((inb.totalDecodeTime - prev.totalDecodeTime) / dFrames) * 1000)
          : 0;
        droppedDelta = (inb.framesDropped ?? 0) - prev.framesDropped;
        lostDelta = (inb.packetsLost ?? 0) - prev.packetsLost;
        freezeDelta = (inb.freezeCount ?? 0) - prev.freezeCount;
      }
      prev = {
        t: now,
        framesDecoded: inb.framesDecoded ?? 0,
        framesDropped: inb.framesDropped ?? 0,
        totalDecodeTime: inb.totalDecodeTime ?? 0,
        packetsLost: inb.packetsLost ?? 0,
        freezeCount: inb.freezeCount ?? 0,
        bytesReceived: inb.bytesReceived ?? 0,
      };

      const decoder: string = inb.decoderImplementation ?? '?';
      const isHardware = !/libvpx|ffmpeg|dav1d|openh264|libaom|software|unknown/i.test(decoder)
        && /nvidia|nvdec|mediafoundation|mft|amf|qualcomm|quicksync|intel|videotoolbox|mediacodec|d3d|dxva|vaapi|hardware|accelerator|external/i.test(decoder);
      // Jitter buffer delay per emitted frame = how far behind live we are.
      const jbDelayMs = inb.jitterBufferEmittedCount
        ? Math.round((inb.jitterBufferDelay / inb.jitterBufferEmittedCount) * 1000) : 0;

      let verdict = 'ok';
      if (droppedDelta > 0 || (!isHardware && decMsPerFrame > 16)) {
        verdict = `⚠️ DECODE-bound (dropped ${droppedDelta} frames, ${decMsPerFrame}ms/frame${isHardware ? '' : ', SOFTWARE decoder'})`;
      } else if (lostDelta > 0 || freezeDelta > 0) {
        verdict = `⚠️ NETWORK downlink (${lostDelta} pkts lost, ${freezeDelta} freezes)`;
      } else if (jbDelayMs > 300) {
        verdict = `⚠️ high latency (${jbDelayMs}ms behind live — buffering)`;
      } else if (decFps > 0 && decFps < 24) {
        verdict = `⚠️ low decode fps ${decFps}`;
      }

      console.log(
        `[recv ${peerLabel}] ${verdict}`,
        {
          codec: (codec?.mimeType ?? '?').replace('video/', ''),
          decoder,
          hw: isHardware,
          fps: inb.framesPerSecond ?? decFps,
          res: `${inb.frameWidth}x${inb.frameHeight}`,
          recvKbps,
          decodeMsPerFrame: decMsPerFrame,
          droppedΔ: droppedDelta,
          lostΔ: lostDelta,
          freezeΔ: freezeDelta,
          jitterBufMs: jbDelayMs,
        },
      );
    }, 2000);
    conn.addEventListener('connectionstatechange', () => {
      if (conn.connectionState === 'closed') clearInterval(timer);
    });
  }

  // Wire stream/close handlers shared by outgoing calls and answered calls.
  function wireMediaConn(peerId: string, call: MediaConnection) {
    let receiverLogging = false;
    call.on('stream', (remote) => {
      updatePeerStream(peerId, remote);
      // Start decode-side logging once, when a remote track first arrives.
      if (!receiverLogging && remote.getVideoTracks().length) {
        receiverLogging = true;
        logReceiverStats(call);
      }
    });
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
      sdpTransform: preferH264Sdp,
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
    call.answer(buildOutboundStream() ?? undefined, { sdpTransform: preferH264Sdp });
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
