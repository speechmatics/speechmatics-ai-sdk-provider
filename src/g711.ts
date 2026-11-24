// G.711 µ-law and A-law to 16-bit PCM, using the ITU-T G.711 expansion. Each
// byte decodes to one sample on its own, so chunks can be decoded separately.

let mulawTable: Int16Array | undefined;
let alawTable: Int16Array | undefined;

function buildMulawTable() {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const t = (((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4);
    table[i] = u & 0x80 ? 0x84 - t : t - 0x84;
  }
  return table;
}

function buildAlawTable() {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const a = i ^ 0x55;
    const segment = (a & 0x70) >> 4;
    let t = (a & 0x0f) << 4;
    t = segment === 0 ? t + 8 : (t + 0x108) << (segment - 1);
    table[i] = a & 0x80 ? t : -t;
  }
  return table;
}

/** Decodes µ-law bytes to 16-bit little-endian PCM bytes. */
export function decodeMulaw(bytes: Uint8Array): Uint8Array {
  return decode(bytes, (mulawTable ??= buildMulawTable()));
}

/** Decodes A-law bytes to 16-bit little-endian PCM bytes. */
export function decodeAlaw(bytes: Uint8Array): Uint8Array {
  return decode(bytes, (alawTable ??= buildAlawTable()));
}

function decode(bytes: Uint8Array, table: Int16Array): Uint8Array {
  const pcm = new Uint8Array(bytes.length * 2);
  for (let i = 0; i < bytes.length; i++) {
    const sample = table[bytes[i]];
    pcm[2 * i] = sample & 0xff;
    pcm[2 * i + 1] = (sample >> 8) & 0xff;
  }
  return pcm;
}
