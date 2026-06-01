import { useState } from 'react';
import { Home } from './Home';
import { Room } from './Room';
import { usePeer } from './usePeer';
import './App.css';

export default function App() {
  const [username, setUsername] = useState('');
  const [roomCode, setRoomCode] = useState('');

  const {
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
  } = usePeer(username);

  function handleCreateRoom(name: string) {
    setUsername(name);
    setTimeout(() => {
      const code = createRoom();
      setRoomCode(code);
    }, 0);
  }

  function handleJoin(name: string, code: string) {
    setUsername(name);
    setTimeout(() => {
      joinRoom(code);
      setRoomCode(code.toUpperCase());
    }, 0);
  }

  if (inRoom) {
    return (
      <Room
        roomCode={roomCode || myId}
        username={username}
        peers={peers}
        messages={messages}
        onSend={sendMessage}
        onLeave={leaveRoom}
        onStartShare={startScreenShare}
        onStopShare={stopScreenShare}
        onToggleMic={toggleMic}
        micEnabled={micEnabled}
      />
    );
  }

  return <Home onCreate={handleCreateRoom} onJoin={handleJoin} />;
}
