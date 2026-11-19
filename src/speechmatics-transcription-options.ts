/**
 * Speechmatics model to use for transcription (sent as `transcription_config.model`,
 * an alias for the operating point). The batch and realtime APIs share these:
 * `enhanced` (highest accuracy), `standard` (fastest), `melia-1` (multilingual)
 * and `oak-1` (multilingual, healthcare). Any other model name the API accepts
 * can be passed as a string.
 */
export type SpeechmaticsTranscriptionModelId =
  | 'enhanced'
  | 'standard'
  | 'melia-1'
  | 'oak-1'
  | (string & {});
