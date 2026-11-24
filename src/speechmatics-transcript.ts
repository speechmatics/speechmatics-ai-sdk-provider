// Converts Speechmatics `json-v2` transcript results into plain text, sentence
// segments, word timings, speaker turns and entities.

export type SpeechmaticsResultItem = {
  type: string;
  start_time: number;
  end_time: number;
  is_eos?: boolean | null;
  attaches_to?: string | null;
  entity_class?: string | null;
  alternatives?: Array<{
    content: string;
    speaker?: string | null;
    confidence?: number | null;
    language?: string | null;
  }> | null;
};

type Timed = { startSecond: number; endSecond: number };

export type SpeechmaticsTranscript = {
  text: string;
  segments: Array<{ text: string } & Timed>;
  words: Array<{ text: string } & Timed>;
  /** Speaker turns. Only present when `includeSpeakers` is set and words carry labels. */
  utterances?: Array<{ speaker: string; text: string } & Timed>;
  /** Entity items. Only present when the transcript contains any. */
  entities?: Array<{ entityClass: string | null; text: string } & Timed>;
};

function createTextBuilder(delimiter: string) {
  let value = '';
  let spaceBeforeNext = false;

  return {
    get value() {
      return value;
    },
    reset() {
      value = '';
      spaceBeforeNext = false;
    },
    append(content: string, attachesTo?: string | null) {
      const separator = value.length > 0 && spaceBeforeNext ? delimiter : '';
      switch (attachesTo) {
        case 'previous':
          value += content;
          spaceBeforeNext = true;
          break;
        case 'both':
          value += content;
          spaceBeforeNext = false;
          break;
        case 'next':
          value += separator + content;
          spaceBeforeNext = false;
          break;
        default:
          value += separator + content;
          spaceBeforeNext = true;
      }
    },
  };
}

/**
 * @param results The `results` array of a `json-v2` transcript.
 * @param wordDelimiter The language pack's word delimiter (`' '` for most
 *   languages, `''` for languages written without spaces).
 * @param options.includeSpeakers Build speaker turns from the `speaker` labels
 *   on words. Speechmatics labels every word `UU` when diarization is off, so
 *   only set this when diarization was requested.
 */
export function buildTranscript(
  results: SpeechmaticsResultItem[],
  wordDelimiter = ' ',
  { includeSpeakers = false }: { includeSpeakers?: boolean } = {},
): SpeechmaticsTranscript {
  const full = createTextBuilder(wordDelimiter);
  const segment = createTextBuilder(wordDelimiter);
  const turn = createTextBuilder(wordDelimiter);
  const segments: SpeechmaticsTranscript['segments'] = [];
  const words: SpeechmaticsTranscript['words'] = [];
  const utterances: NonNullable<SpeechmaticsTranscript['utterances']> = [];
  const entities: NonNullable<SpeechmaticsTranscript['entities']> = [];

  let segmentStart: number | undefined;
  let segmentEnd = 0;
  let turnSpeaker: string | undefined;
  let turnStart = 0;
  let turnEnd = 0;

  const closeSegment = () => {
    if (segmentStart != null && segment.value.length > 0) {
      segments.push({
        text: segment.value,
        startSecond: segmentStart,
        endSecond: segmentEnd,
      });
    }
    segment.reset();
    segmentStart = undefined;
  };

  const closeTurn = () => {
    if (turnSpeaker != null && turn.value.length > 0) {
      utterances.push({
        speaker: turnSpeaker,
        text: turn.value,
        startSecond: turnStart,
        endSecond: turnEnd,
      });
    }
    turn.reset();
  };

  for (const item of results) {
    const alternative = item.alternatives?.[0];

    // Entity items repeat the words they cover, so they never contribute to the
    // text. They are reported separately.
    if (item.type === 'entity') {
      if (alternative != null) {
        entities.push({
          entityClass: item.entity_class ?? null,
          text: alternative.content,
          startSecond: item.start_time,
          endSecond: item.end_time,
        });
      }
      continue;
    }

    if (item.type !== 'word' && item.type !== 'punctuation') continue;
    if (alternative == null) continue;
    const content = alternative.content;

    const attachesTo = item.type === 'punctuation' ? item.attaches_to : null;

    if (item.type === 'word') {
      words.push({
        text: content,
        startSecond: item.start_time,
        endSecond: item.end_time,
      });

      const speaker = alternative.speaker;
      if (includeSpeakers && speaker != null && speaker !== turnSpeaker) {
        closeTurn();
        turnSpeaker = speaker;
        turnStart = item.start_time;
      }
    }

    full.append(content, attachesTo);
    segment.append(content, attachesTo);
    if (includeSpeakers && turnSpeaker != null) {
      turn.append(content, attachesTo);
      turnEnd = item.end_time;
    }
    segmentStart ??= item.start_time;
    segmentEnd = item.end_time;

    if (item.type === 'punctuation' && item.is_eos) {
      closeSegment();
    }
  }

  closeSegment();
  closeTurn();

  return {
    text: full.value,
    segments,
    words,
    ...(utterances.length > 0 ? { utterances } : {}),
    ...(entities.length > 0 ? { entities } : {}),
  };
}
