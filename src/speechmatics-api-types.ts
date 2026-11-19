// Request shapes for the Speechmatics batch API (POST /v2/jobs). Response shapes
// are validated with zod schemas next to where they are used.

export type SpeechmaticsTranscriptionConfig = {
  language: string;
  model?: string;
  domain?: string;
  output_locale?: string;
  diarization?: 'none' | 'speaker' | 'channel';
  additional_vocab?: Array<{ content: string; sounds_like?: string[] }>;
  enable_entities?: boolean;
};

export type SpeechmaticsJobConfig = {
  type: 'transcription';
  transcription_config: SpeechmaticsTranscriptionConfig;
  fetch_data?: { url: string };
};
