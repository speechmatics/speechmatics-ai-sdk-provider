import type {
  FetchFunction,
  Resolvable,
  WebSocketConstructor,
} from '@ai-sdk/provider-utils';

export type SpeechmaticsConfig = {
  provider: string;
  url: (options: { path: string }) => string;
  headers?: Resolvable<Record<string, string | undefined>>;
  fetch?: FetchFunction;

  /** Builds a Realtime or Agent STT WebSocket URL from a path such as `/v2`. */
  realtimeUrl?: (options: { path: string }) => string;
  /** Returns a temporary key for one streaming session. */
  getTemporaryKey?: (options: { abortSignal?: AbortSignal }) => Promise<string>;
  webSocket?: WebSocketConstructor;
};
