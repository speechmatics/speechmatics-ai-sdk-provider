import { describe, expect, it } from 'vitest';
import { decodeAlaw, decodeMulaw } from './g711';

const samples = (pcm: Uint8Array) =>
  Array.from(new Int16Array(new Uint8Array(pcm).buffer));

describe('decodeMulaw', () => {
  it('decodes the ITU-T G.711 reference values', () => {
    expect(
      samples(decodeMulaw(new Uint8Array([0xff, 0x7f, 0x00, 0x80]))),
    ).toEqual([0, 0, -32124, 32124]);
  });

  it('writes 16-bit little-endian samples, two bytes per input byte', () => {
    const pcm = decodeMulaw(new Uint8Array([0x80]));
    expect([...pcm]).toEqual([32124 & 0xff, 32124 >> 8]);
  });

  it('is symmetric and monotonic within each sign', () => {
    const all = samples(
      decodeMulaw(Uint8Array.from({ length: 256 }, (_, i) => i)),
    );
    for (let i = 0; i < 128; i++) expect(all[i] + all[i + 128]).toBe(0);
    for (let i = 0; i < 127; i++) expect(all[i]).toBeLessThan(all[i + 1]);
  });
});

describe('decodeAlaw', () => {
  it('decodes the ITU-T G.711 reference values', () => {
    expect(
      samples(decodeAlaw(new Uint8Array([0xd5, 0x55, 0x2a, 0xaa]))),
    ).toEqual([8, -8, -32256, 32256]);
  });

  it('is symmetric between the sign halves', () => {
    const all = samples(
      decodeAlaw(Uint8Array.from({ length: 256 }, (_, i) => i)),
    );
    for (let i = 0; i < 128; i++) expect(all[i] + all[i + 128]).toBe(0);
  });

  it('returns an empty array for empty input', () => {
    expect(decodeAlaw(new Uint8Array(0))).toEqual(new Uint8Array(0));
  });
});
