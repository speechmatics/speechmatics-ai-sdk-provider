// 32-bit float PCM to 16-bit PCM. Expects whole samples, 4 bytes each.

/** Converts 32-bit float little-endian PCM bytes to 16-bit little-endian PCM bytes. */
export function decodeFloat32(bytes: Uint8Array): Uint8Array {
  const count = Math.floor(bytes.length / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 4);
  const pcm = new Uint8Array(count * 2);
  for (let i = 0; i < count; i++) {
    const value = Math.max(-1, Math.min(1, view.getFloat32(4 * i, true)));
    const sample = value < 0 ? value * 0x8000 : value * 0x7fff;
    const rounded = Number.isNaN(sample) ? 0 : Math.round(sample);
    pcm[2 * i] = rounded & 0xff;
    pcm[2 * i + 1] = (rounded >> 8) & 0xff;
  }
  return pcm;
}
