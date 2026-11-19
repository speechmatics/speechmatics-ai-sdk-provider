import type { FetchFunction, Resolvable } from '@ai-sdk/provider-utils';

export type SpeechmaticsConfig = {
  provider: string;
  url: (options: { path: string }) => string;
  headers?: Resolvable<Record<string, string | undefined>>;
  fetch?: FetchFunction;
};
