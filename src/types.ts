export interface ChatMessage {
  id: string;
  user: string;
  text: string;
  timestamp: number;
}

export interface Peer {
  id: string;
  stream?: MediaStream;
  username: string;
}

export type AppScreen = 'home' | 'room';
