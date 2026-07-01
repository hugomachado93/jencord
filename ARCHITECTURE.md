# Jencord Architecture

Jencord is a peer-to-peer screen-sharing app for a small group of friends (built for ~5 people). It works like a stripped-down Discord: create a room, share the code, and everyone joins a video mesh. There is **no media server** — every participant connects directly to every other participant over WebRTC. A signaling server (PeerJS's public broker) is used only to introduce peers to each other; once connected, all audio/video/chat flows peer-to-peer.

The app ships two ways:
- **Browser** — uses `getDisplayMedia` for screen capture.
- **Electron desktop** — uses `desktopCapturer` + `getUserMedia` so it can offer a source picker and set desktop-specific capture constraints.

---

## Tech stack

| Layer | Choice |
|---|---|
| UI | React + TypeScript |
| Bundler | Vite |
| P2P | PeerJS (wraps WebRTC `RTCPeerConnection` + a signaling broker) |
| Desktop shell | Electron |

---

## File map

```
src/
  App.tsx        Top-level screen switch (Home <-> Room)
  Home.tsx       Landing: enter name, create or join a room
  Room.tsx       In-call UI: video grid, toolbar, source picker, chat sidebar
  VideoTile.tsx  One video element + label + fullscreen
  Chat.tsx       Text chat panel
  usePeer.ts     ALL the P2P logic (the heart of the app)
  types.ts       Shared TypeScript types
electron/
  main.js        Electron main process: window, permissions, source list
  preload.cjs    Bridges getSources / getScreenAccess to the renderer
```

Almost all the interesting logic lives in **`usePeer.ts`**. Everything else is presentation.

---

## Core concepts

### Two channels per peer
For each peer we hold **two** separate WebRTC connections:

1. **Data connection** (`DataConnection`) — a JSON message channel. Carries chat, `hello` (name exchange), `roster` (peer discovery), and `request-call`. Its lifetime = the peer's presence in the room. When it closes, the peer has truly left.
2. **Media connection** (`MediaConnection`) — the audio/video call. Its lifetime = "is this peer currently sending me media." It can open and close many times (start/stop screen share) without the peer leaving the room.

This split is important: **closing a media connection does not remove a peer.** Only a closed data connection does.

### The mesh
There is no host that relays traffic. When you join, you connect to the room creator, then the creator sends you a **roster** of everyone else, and you dial each of them directly. The result is a full mesh where every peer has a direct connection to every other peer.

### IDs decide who dials whom
PeerJS IDs are strings. To avoid two peers dialing each other simultaneously ("glare"), the rule is: **the lower ID initiates.** This appears in both `connectToPeer` (data) and `handleIncomingCall` (media).

---

## State vs refs in `usePeer.ts`

React state (drives UI, triggers re-render):

| State | Purpose |
|---|---|
| `myId` | Our own PeerJS ID |
| `peers` | Map of peerId → `{ id, username, stream? }` — renders the video grid |
| `messages` | Chat log |
| `inRoom` | Are we in a call (switches App from Home to Room) |
| `micEnabled` | Mic toggle button state |

Refs (persist across renders, never trigger re-render):

| Ref | Purpose |
|---|---|
| `peerRef` | The PeerJS instance |
| `dataConns` | Map of peerId → data connection |
| `mediaConns` | Map of peerId → media call |
| `localStreamRef` | Our screen-capture stream |
| `micStreamRef` | Our mic stream |
| `peerNames` | peerId → username lookup |
| `usernameRef` | Live copy of our name — read inside long-lived PeerJS callbacks that would otherwise capture a stale value |
| `myIdRef` | Live copy of `myId` for the same reason |

---

## Function reference

### Helpers

- **`randomCode()`** — Generates a room code like `WOLF-7823` (animal word + 4 digits). The room creator becomes this ID on the signaling server.
- **`pc(call)`** — Reaches into a PeerJS `MediaConnection` to grab the underlying raw `RTCPeerConnection`. PeerJS doesn't expose codec/bitrate controls, so we operate on the raw connection for the streaming-quality tuning.

### State updaters

- **`addMessage(msg)`** — Appends a chat message.
- **`updatePeerStream(id, stream)`** — Attaches (or clears, with `undefined`) a peer's media stream so their tile shows video. Called when a media `stream` event fires, and cleared when their media connection closes.
- **`addPeer(id, uname)`** — Records a peer in the roster and stores their username. Called on `hello`, `roster`, and incoming calls.
- **`removePeer(id)`** — Peer has genuinely left (data connection closed). Removes them from state, both connection maps, the name lookup, and closes any lingering media call.

### Messaging

- **`broadcast(data)`** — Sends one JSON object to every connected data channel. Used for chat and roster gossip.
- **`rosterList(exclude?)`** — Builds the array of `{ id, username }` we send in a `roster` message, optionally omitting one peer (typically the newcomer we're replying to).
- **`handleDataConn(conn)`** — Registers a data connection and wires its message router:
  - `chat` → add to messages
  - `hello` → learn the peer's username
  - `roster` → discover other peers and `connectToPeer` each one (this is what forms the mesh)
  - `request-call` → a peer with no stream is asking us to call them; we send our outbound stream
  - On `close` → `removePeer` (real departure).

### Streaming quality (the FPS fixes)

- **`applyGameStreamingParams(call)`** — Once the connection is `connected`, sets on the video sender: `maxBitrate` 12 Mbps, `degradationPreference: 'maintain-framerate'` (drop resolution before frame rate), and `priority: 'high'`. Without this, WebRTC defaults to a low bitrate and sacrifices FPS under load — bad for games.
- **`preferH264(call)`** — Reorders the codec list to prefer H.264, then VP9, then VP8, and applies it to the video transceiver **before** the SDP offer is built. H.264 uses the GPU's hardware encoder (NVENC / VideoToolbox), keeping the CPU free for the game. VP8 (the WebRTC default) is software-encoded and CPU-heavy.

### Media connection management

- **`wireMediaConn(peerId, call)`** — Shared `stream`/`close` handlers for any media call. On `stream`, shows the remote video. On `close`, clears only that peer's video (they stay in the room) — but guards against clobbering a newer connection that may have replaced this one during glare.
- **`callPeer(peerId, stream)`** — Opens a **new** outbound media call: dials, stores it, applies `preferH264` + `applyGameStreamingParams`, wires handlers.
- **`updateOutboundForPeer(peerId, stream)`** — The smart updater used whenever our outgoing media changes (start share, toggle mic). Instead of always redialing:
  - No existing call → `callPeer`.
  - Same track kinds → `replaceTrack` on the existing senders (instant, no renegotiation, no leaked connection).
  - A new track kind appears (e.g. adding audio to a video-only call) → close the old call cleanly and redial.
  - A track kind disappears → `replaceTrack(null)`.
- **`removeVideoFromPeers()`** — Nulls the video track on every peer's sender. Used by stop-share when no audio remains.

### Connection setup

- **`connectToPeer(id)`** — Dials a peer's data channel, but only if we don't already have one **and** our ID is lower (glare avoidance). This is how a newcomer reaches peers listed in a roster.
- **`onDataOpen(conn)`** — Runs when any data connection opens (either side). It: registers the connection, sends `hello`, sends the newcomer a `roster` of everyone else, broadcasts an updated roster so the rest of the mesh learns about the newcomer, and then either sends our stream if we have one or (if we have nothing to send and are the higher ID) sends `request-call` so the peer initiates media toward us.
- **`handleIncomingCall(call)`** — Answers an incoming media call. Handles glare: if we already have a media connection to this peer, the lower ID wins (higher ID drops its own and accepts theirs). Answers with our combined stream, applies the quality tuning, wires handlers.
- **`setupPeer(peer, onOpen?)`** — Shared PeerJS wiring for both create and join paths: on `open` record our ID and mark us in-room; on `connection`/`call` route to `onDataOpen` / `handleIncomingCall`. The optional `onOpen` lets `joinRoom` dial the room creator once our ID is ready.

### Public API (returned from the hook)

- **`createRoom(name)`** — Stores our name, generates a room code, creates a PeerJS peer with that code as ID, returns the code to display. We now sit and wait for others.
- **`joinRoom(name, code)`** — Stores our name, creates a peer with a unique ID (`CODE-xxxx`), and once open dials the room creator. The roster exchange then pulls us into the full mesh.
- **`startScreenShare(sourceId?, fps?)`** — Captures the screen. In Electron with a `sourceId`, uses `getUserMedia` with the desktop constraints (capped to 1080p at the chosen FPS); in the browser uses `getDisplayMedia`. Listens for the track's `ended` event (the OS "stop sharing" button) to clean up. Then pushes the new stream to every peer via `updateOutboundForPeer`.
- **`stopScreenShare()`** — Stops the local capture tracks. If the mic is still on, re-sends an audio-only stream (keeps voice, drops video); otherwise nulls the video on all peers. Peers stay in the room — they just stop seeing our screen (no frozen last frame).
- **`buildOutboundStream()`** — Combines our current screen video + mic audio into a single `MediaStream` to send. Returns `null` if we have neither.
- **`toggleMic()`** — Turns the mic on (grabs an audio stream) or off (stops it), then updates all peers. If the mic was our only track and it's now off, nulls the audio senders.
- **`sendMessage(text)`** — Builds a chat message, shows it locally, and broadcasts it to all peers.
- **`leaveRoom()`** — Full teardown: stop all tracks, destroy the PeerJS instance (which closes every connection), clear all maps and state, return to Home.

---

## Message protocol (data channel)

All peer-to-peer control messages are JSON objects with a `type`:

| Type | Payload | Meaning |
|---|---|---|
| `hello` | `{ username }` | "Here's my name" — sent right after a data connection opens |
| `roster` | `{ peers: [{id, username}] }` | "Here's who else is in the room" — drives mesh discovery |
| `chat` | `{ msg: ChatMessage }` | A chat message |
| `request-call` | — | "I have no stream to send you; please call me" |

---

## Typical flows

### Creating a room
1. User enters a name, clicks **Create Room** (`Home.tsx`).
2. `App.handleCreateRoom` → `createRoom(name)` → `setupPeer(new Peer(code))`.
3. PeerJS registers `code` on the broker. We display it and wait.

### Joining a room
1. User enters name + code, clicks **Join** (`Home.tsx`).
2. `App.handleJoin` → `joinRoom(name, code)` → `setupPeer(new Peer("CODE-xxxx"), onOpen)`.
3. On open we dial the creator's data channel → `onDataOpen`.
4. The creator replies with a `roster`; we `connectToPeer` each other member.
5. Every member exchanges `hello`/`roster` and (if anyone is sharing) media calls. Full mesh formed.

### Sharing a game
1. Click **Share Screen** (`Room.tsx`). In Electron, pick a source.
2. `startScreenShare` captures at up to 1080p / chosen FPS.
3. For each peer, `updateOutboundForPeer` either replaces the video track on an existing call or opens a new one.
4. Each new/updated call negotiates **H.264** and runs at **12 Mbps, maintain-framerate** — the tuning that keeps game FPS high.

---

## Known limitations

- **Mesh scaling** — Every peer uploads their stream to every other peer. Fine for ~5 people; upload bandwidth becomes the ceiling beyond that. A real product would use an SFU (selective forwarding unit) server.
- **Signaling dependency** — Relies on PeerJS's public broker to introduce peers. It only handles introductions, not media, but if it's down, new peers can't connect.
- **FPS tuning is unverified live** — The H.264 preference and bitrate settings are implemented but should be confirmed with a real game stream via `chrome://webrtc-internals` (check negotiated `codecId` and `framesPerSecond`). If H.264 isn't available on a machine, it falls back to VP9/VP8.
