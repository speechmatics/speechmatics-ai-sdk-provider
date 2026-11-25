// Resamples 16-bit PCM between sample rates, chunk by chunk, with a
// Hann-windowed sinc filter. Used for Agent STT, which accepts 8 or 16 kHz only,
// so audio such as Firefox's 48 kHz microphone can still be sent. The filter
// looks ahead ZERO_CROSSINGS input samples (under 1 ms at 48 kHz), and `flush`
// sends those last samples at the end of the stream.

const ZERO_CROSSINGS = 8;

export type Resampler = {
  /** Resamples 16-bit little-endian PCM bytes, in whole samples. */
  process: (pcm: Uint8Array) => Uint8Array;
  /** Returns the samples still held back for the filter. */
  flush: () => Uint8Array;
};

export function createResampler(from: number, to: number): Resampler {
  const divisor = gcd(from, to);
  // Each output sample advances `down / up` input samples, so the fractional
  // position cycles through `up` phases, each with its own filter.
  const up = to / divisor;
  const down = from / divisor;
  // When downsampling, the cutoff drops to the new Nyquist frequency to stop
  // higher frequencies folding into the speech band.
  const cutoff = Math.min(1, to / from);
  const half = Math.ceil(ZERO_CROSSINGS / cutoff);
  const filters = new Map<number, Float32Array>();
  const filterFor = (phase: number) => {
    let filter = filters.get(phase);
    if (filter == null) {
      filter = buildFilter(phase / up, half, cutoff);
      filters.set(phase, filter);
    }
    return filter;
  };

  // `buffer[position]` is the input sample at or just before the next output.
  let buffer = new Float32Array(half - 1);
  let position = half - 1;
  let phase = 0;
  let samplesIn = 0;
  let samplesOut = 0;

  const run = (input: Float32Array, limit: number) => {
    const joined = new Float32Array(buffer.length + input.length);
    joined.set(buffer);
    joined.set(input, buffer.length);
    buffer = joined;

    const output: number[] = [];
    while (position + half < buffer.length && samplesOut < limit) {
      const filter = filterFor(phase);
      const start = position - half + 1;
      let sum = 0;
      for (let k = 0; k < filter.length; k++) sum += filter[k] * buffer[start + k];
      output.push(sum);
      samplesOut++;
      phase += down;
      position += Math.floor(phase / up);
      phase %= up;
    }

    const keep = Math.min(position - half + 1, buffer.length);
    buffer = buffer.slice(keep);
    position -= keep;
    return toBytes(output);
  };

  return {
    process(pcm) {
      const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      const input = new Float32Array(pcm.byteLength >> 1);
      for (let i = 0; i < input.length; i++) {
        input[i] = view.getInt16(2 * i, true);
      }
      samplesIn += input.length;
      return run(input, Infinity);
    },
    flush() {
      return run(
        new Float32Array(half),
        Math.ceil((samplesIn * up) / down),
      );
    },
  };
}

function buildFilter(fraction: number, half: number, cutoff: number) {
  const filter = new Float32Array(2 * half);
  let total = 0;
  for (let k = 0; k < filter.length; k++) {
    const x = k - half + 1 - fraction;
    const window = 0.5 + 0.5 * Math.cos((Math.PI * x) / half);
    const t = Math.PI * cutoff * x;
    filter[k] = (t === 0 ? 1 : Math.sin(t) / t) * window;
    total += filter[k];
  }
  // Scale so a constant signal keeps its level.
  for (let k = 0; k < filter.length; k++) filter[k] /= total;
  return filter;
}

function toBytes(samples: number[]) {
  const pcm = new Uint8Array(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-32768, Math.min(32767, Math.round(samples[i])));
    pcm[2 * i] = sample & 0xff;
    pcm[2 * i + 1] = (sample >> 8) & 0xff;
  }
  return pcm;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}
