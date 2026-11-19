import { describe, expect, it } from 'vitest';
import {
  buildTranscript,
  type SpeechmaticsResultItem,
} from './speechmatics-transcript';

const word = (
  content: string,
  start: number,
  end: number,
): SpeechmaticsResultItem => ({
  type: 'word',
  start_time: start,
  end_time: end,
  alternatives: [{ content }],
});

const punctuation = (
  content: string,
  time: number,
  attachesTo: string,
  isEos = false,
): SpeechmaticsResultItem => ({
  type: 'punctuation',
  start_time: time,
  end_time: time,
  attaches_to: attachesTo,
  is_eos: isEos,
  alternatives: [{ content }],
});

describe('buildTranscript', () => {
  it('attaches punctuation to the previous word and splits segments on end of sentence', () => {
    const result = buildTranscript([
      word('Hello', 0, 0.4),
      punctuation(',', 0.4, 'previous'),
      word('world', 0.5, 0.9),
      punctuation('.', 0.9, 'previous', true),
      word('How', 1.2, 1.4),
      word('are', 1.4, 1.6),
      word('you', 1.6, 1.9),
      punctuation('?', 1.9, 'previous', true),
    ]);

    expect(result.text).toBe('Hello, world. How are you?');
    expect(result.segments).toEqual([
      { text: 'Hello, world.', startSecond: 0, endSecond: 0.9 },
      { text: 'How are you?', startSecond: 1.2, endSecond: 1.9 },
    ]);
    expect(result.words.map(w => w.text)).toEqual([
      'Hello',
      'world',
      'How',
      'are',
      'you',
    ]);
  });

  it('keeps a trailing segment that has no end of sentence', () => {
    const result = buildTranscript([
      word('no', 0, 0.2),
      word('full', 0.2, 0.4),
      word('stop', 0.4, 0.7),
    ]);

    expect(result.segments).toEqual([
      { text: 'no full stop', startSecond: 0, endSecond: 0.7 },
    ]);
  });

  it('handles punctuation that attaches to the next word and to both sides', () => {
    const result = buildTranscript([
      word('say', 0, 0.2),
      punctuation('(', 0.2, 'next'),
      word('hello', 0.2, 0.5),
      punctuation(')', 0.5, 'previous'),
      word('well', 0.6, 0.8),
      punctuation('-', 0.8, 'both'),
      word('known', 0.8, 1),
    ]);

    expect(result.text).toBe('say (hello) well-known');
  });

  it('uses the language pack word delimiter', () => {
    const result = buildTranscript(
      [word('你', 0, 0.2), word('好', 0.2, 0.4), punctuation('。', 0.4, 'previous', true)],
      '',
    );

    expect(result.text).toBe('你好。');
  });

  it('ignores entity items so words are not repeated', () => {
    const result = buildTranscript([
      word('twenty', 0, 0.3),
      word('five', 0.3, 0.6),
      {
        type: 'entity',
        start_time: 0,
        end_time: 0.6,
        alternatives: [{ content: '25' }],
      },
    ]);

    expect(result.text).toBe('twenty five');
  });

  it('returns empty output for an empty transcript', () => {
    expect(buildTranscript([])).toEqual({ text: '', segments: [], words: [] });
  });

  describe('speakers and entities', () => {
    const spoken = (
      content: string,
      start: number,
      end: number,
      speaker: string,
    ): SpeechmaticsResultItem => ({
      type: 'word',
      start_time: start,
      end_time: end,
      alternatives: [{ content, speaker }],
    });

    const conversation = [
      spoken('Hi', 0, 0.3, 'S1'),
      spoken('there', 0.3, 0.6, 'S1'),
      punctuation('.', 0.6, 'previous', true),
      spoken('Hello', 1, 1.4, 'S2'),
      punctuation('!', 1.4, 'previous', true),
      spoken('Hi', 2, 2.2, 'S1'),
    ];

    it('groups consecutive words by speaker when speakers are requested', () => {
      const { utterances } = buildTranscript(conversation, ' ', {
        includeSpeakers: true,
      });

      expect(utterances).toEqual([
        { speaker: 'S1', text: 'Hi there.', startSecond: 0, endSecond: 0.6 },
        { speaker: 'S2', text: 'Hello!', startSecond: 1, endSecond: 1.4 },
        { speaker: 'S1', text: 'Hi', startSecond: 2, endSecond: 2.2 },
      ]);
    });

    it('ignores speaker labels unless speakers are requested', () => {
      // Speechmatics labels every word UU when diarization is off.
      const result = buildTranscript(conversation);

      expect(result).not.toHaveProperty('utterances');
    });

    it('reports entities without adding them to the text', () => {
      const result = buildTranscript([
        word('twenty', 0, 0.3),
        word('five', 0.3, 0.6),
        {
          type: 'entity',
          entity_class: 'cardinal',
          start_time: 0,
          end_time: 0.6,
          alternatives: [{ content: '25' }],
        },
      ]);

      expect(result.text).toBe('twenty five');
      expect(result.entities).toEqual([
        { entityClass: 'cardinal', text: '25', startSecond: 0, endSecond: 0.6 },
      ]);
    });
  });
});
