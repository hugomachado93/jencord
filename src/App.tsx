import { useState, useEffect } from 'react';
import { HashRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { Home } from './Home';
import { Room } from './Room';
import { usePeer } from './usePeer';
import './App.css';

// HashRouter (not BrowserRouter): Electron loads via file:// in production,
// where path-based routing breaks on reload. Hash routing works everywhere.
export default function App() {
  return (
    <HashRouter>
      <AppRoutes />
    </HashRouter>
  );
}

function AppRoutes() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [roomCode, setRoomCode] = useState('');

  const peer = usePeer(username);

  // Navigation follows connection state — the single source of truth.
  // createRoom/joinRoom connect asynchronously (PeerJS 'open'); inRoom flips
  // when actually connected, and leaveRoom flips it back.
  useEffect(() => {
    navigate(peer.inRoom ? '/room' : '/');
  }, [peer.inRoom, navigate]);

  function handleCreateRoom(name: string) {
    setUsername(name);
    setRoomCode(peer.createRoom(name));
  }

  function handleJoin(name: string, code: string) {
    setUsername(name);
    peer.joinRoom(name, code);
    setRoomCode(code.toUpperCase());
  }

  return (
    <Routes>
      <Route path="/" element={<Home onCreate={handleCreateRoom} onJoin={handleJoin} />} />
      <Route
        path="/room"
        element={
          // Direct nav / reload lands here without a live connection — send home.
          peer.inRoom ? (
            <Room
              roomCode={roomCode || peer.myId}
              username={username}
              peers={peer.peers}
              messages={peer.messages}
              onSend={peer.sendMessage}
              onLeave={peer.leaveRoom}
              onStartShare={peer.startScreenShare}
              onStopShare={peer.stopScreenShare}
              onToggleMic={peer.toggleMic}
              micEnabled={peer.micEnabled}
            />
          ) : (
            <Navigate to="/" replace />
          )
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
