import { describe, expect, it } from 'vitest';
import { decodeFloat32 } from './float32';

const floats = (...values: number[]) =>
  new Uint8Array(new Float32Array(values).buffer);
const samples = (pcm: Uint8Array) =>
  Array.from(new Int16Array(new Uint8Array(pcm).buffer));

describe('decodeFloat32', () => {
  it('scales -1 to 1 onto the 16-bit range', () => {
    expect(samples(decodeFloat32(floats(0, 1, -1, 0.5, -0.5)))).toEqual([
      0, 32767, -32768, 16384, -16384,
    ]);
  });

  it('clips values outside -1 to 1 and turns NaN into silence', () => {
    expect(samples(decodeFloat32(floats(2, -2, NaN)))).toEqual([
      32767, -32768, 0,
    ]);
  });

  it('reads chunks that start part way into their buffer', () => {
    const padded = new Uint8Array(9);
    padded.set(floats(1, -1), 1);
    expect(samples(decodeFloat32(padded.subarray(1)))).toEqual([
      32767, -32768,
    ]);
  });
});
