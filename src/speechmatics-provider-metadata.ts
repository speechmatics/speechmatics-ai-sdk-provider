// Shapes of `providerMetadata.speechmatics`. The AI SDK types provider metadata
// as plain JSON, so cast to these to read it:
//
//   const metadata = part.providerMetadata?.speechmatics as
//     | SpeechmaticsStreamPartMetadata
//     | undefined;
//
// All times are in seconds from the start of the audio.

/** A recognised word. */
export type SpeechmaticsWord = {
  text: string;
  startSecond: number;
  endSecond: number;
  confidence?: number;
  /** With `diarization: 'speaker'`. */
  speaker?: string;
  /** `melia-1` only. */
  language?: string;
};

/** A speaker turn, with `diarization` set. */
export type SpeechmaticsUtterance = {
  speaker: string;
  text: string;
  startSecond: number;
  endSecond: number;
};

/** An entity such as a date or number, with `enableEntities: true`. */
export type SpeechmaticsEntity = {
  entityClass: string | null;
  text: string;
  startSecond: number;
  endSecond: number;
};

/** `providerMetadata.speechmatics` of a `transcribe` result. */
export type SpeechmaticsTranscriptionMetadata = {
  jobId: string;
  utterances?: SpeechmaticsUtterance[];
  entities?: SpeechmaticsEntity[];
};

/**
 * `providerMetadata.speechmatics` of a streamed `transcript-partial` or
 * `transcript-final` part.
 */
export type SpeechmaticsStreamPartMetadata = {
  /** `enhanced`, `standard` and `melia-1` final parts. */
  words?: SpeechmaticsWord[];
  /**
   * `enhanced` and `standard` final parts, when `endOfUtteranceSilenceTrigger`
   * is above 0. `true` when the part is followed by that much silence.
   */
  endOfUtterance?: boolean;
  /** `linden-1`, with `diarization: 'speaker'`. */
  speaker?: string;
  /** `linden-1`. Only present, as `true`, on the first part of a turn. */
  startOfTurn?: true;
  /** `linden-1` final parts. `true` when the part ends the speaker's turn. */
  endOfTurn?: boolean;
};

/** `providerMetadata.speechmatics` of an `experimental_streamTranscribe` result. */
export type SpeechmaticsStreamMetadata = {
  sessionId?: string;
  utterances?: SpeechmaticsUtterance[];
  entities?: SpeechmaticsEntity[];
  /** `Warning` messages Speechmatics sent during the session, as received. */
  warnings?: Array<{ message: 'Warning'; type?: string; reason?: string }>;
};
