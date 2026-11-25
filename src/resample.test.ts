import { describe, expect, it } from 'vitest';
import { createResampler } from './resample';

const tone = (rate: number, hz: number, seconds: number, level = 10000) => {
  const samples = new Int16Array(Math.round(rate * seconds));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.round(level * Math.sin((2 * Math.PI * hz * i) / rate));
  }
  return new Uint8Array(samples.buffer);
};
const samples = (pcm: Uint8Array) =>
  Array.from(new Int16Array(new Uint8Array(pcm).buffer));
const join = (...chunks: Uint8Array[]) => {
  const result = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};
const resampleAll = (from: number, to: number, ...chunks: Uint8Array[]) => {
  const resampler = createResampler(from, to);
  return samples(join(...chunks.map(resampler.process), resampler.flush()));
};
// Root mean square level, skipping the filter's edges.
const rms = (values: number[]) => {
  const middle = values.slice(100, -100);
  return Math.sqrt(middle.reduce((n, v) => n + v * v, 0) / middle.length);
};

describe('createResampler', () => {
  it.each([
    [48000, 16000],
    [44100, 16000],
    [24000, 16000],
    [11025, 16000],
    [48000, 8000],
  ])('turns %i Hz into %i Hz with one output per input period', (from, to) => {
    const output = resampleAll(from, to, tone(from, 440, 1));
    expect(output).toHaveLength(to);
  });

  it.each([
    [48000, 16000],
    [44100, 16000],
    [11025, 16000],
  ])('keeps the level and pitch of a 1 kHz tone from %i Hz', from => {
    const output = resampleAll(from, 16000, tone(from, 1000, 1));
    const expected = samples(tone(16000, 1000, 1));

    expect(rms(output)).toBeCloseTo(rms(expected), -1);
    const error = output.map((v, i) => v - expected[i]);
    expect(rms(error)).toBeLessThan(rms(expected) * 0.01);
  });

  it('filters out tones above the new Nyquist frequency', () => {
    // 10 kHz can't be represented at 16 kHz; without filtering it would fold
    // down to 6 kHz at full level.
    const output = resampleAll(48000, 16000, tone(48000, 10000, 1));
    expect(rms(output)).toBeLessThan(10000 * 0.01);
  });

  it('gives the same output however the input is split', () => {
    const input = tone(44100, 700, 0.5);
    const whole = resampleAll(44100, 16000, input);
    const split = resampleAll(
      44100,
      16000,
      input.subarray(0, 2),
      input.subarray(2, 1000),
      input.subarray(1000, 1002),
      input.subarray(1002),
    );
    expect(split).toEqual(whole);
  });

  it('returns nothing until it has enough audio, then nothing on flush', () => {
    const resampler = createResampler(48000, 16000);
    expect(resampler.process(new Uint8Array(4))).toHaveLength(0);
    expect(samples(resampler.flush())).toEqual([0]);
    expect(resampler.flush()).toHaveLength(0);
  });

  it('clips instead of wrapping around at full scale', () => {
    const square = new Int16Array(4800).map((_, i) =>
      i % 96 < 48 ? 32767 : -32768,
    );
    const output = resampleAll(48000, 16000, new Uint8Array(square.buffer));
    expect(Math.max(...output)).toBeLessThanOrEqual(32767);
    expect(Math.min(...output)).toBeGreaterThanOrEqual(-32768);
    expect(output.slice(100, -100).some(v => v > 30000)).toBe(true);
  });
});
