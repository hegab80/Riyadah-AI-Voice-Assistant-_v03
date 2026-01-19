
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface MessageLog {
  role: 'user' | 'assistant';
  text: string;
  timestamp: Date;
}

export interface VoiceState {
  isSpeaking: boolean;
  isListening: boolean;
}
