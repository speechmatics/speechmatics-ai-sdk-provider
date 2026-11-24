/**
 * Models offered for batch transcription. They are sent as
 * `transcription_config.model`, an alias for the operating point.
 *
 * - `enhanced`: highest accuracy on single-language audio.
 * - `standard`: fastest, for throughput and latency.
 * - `melia-1`: multilingual audio, selected with `language: 'multi'`.
 */
export const SPEECHMATICS_BATCH_MODEL_IDS = [
  'enhanced',
  'standard',
  'melia-1',
] as const;

/**
 * Models offered for streaming (realtime) transcription.
 *
 * - `enhanced`, `standard`, `melia-1`: the Realtime API, as for batch.
 * - `linden-1`: the Agent STT API, built for voice agents. It returns
 *   speaker-attributed segments and detects the end of each turn. Streaming only.
 */
export const SPEECHMATICS_REALTIME_MODEL_IDS = [
  ...SPEECHMATICS_BATCH_MODEL_IDS,
  'linden-1',
] as const;

export type SpeechmaticsTranscriptionModelId =
  (typeof SPEECHMATICS_REALTIME_MODEL_IDS)[number];
