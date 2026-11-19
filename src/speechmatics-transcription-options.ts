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

export type SpeechmaticsTranscriptionModelId =
  (typeof SPEECHMATICS_BATCH_MODEL_IDS)[number];
