// Usage: SPEECHMATICS_API_KEY=... node examples/stream-transcribe.mjs <16-bit-pcm.wav> [model]
//
// Streams a WAV file at real time, as a microphone would, and prints results as
// they arrive. The file must be 16-bit PCM; linden-1 also needs 8 or 16 kHz.
import { readFile } from 'node:fs/promises';
import { experimental_streamTranscribe as streamTranscribe } from 'ai';
import { speechmatics } from '../dist/index.js';

const [file, model = 'enhanced'] = process.argv.slice(2);
if (!file) {
  console.error('Pass a 16-bit PCM WAV file');
  process.exit(1);
}

const wav = await readFile(file);
const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
const rate = view.getUint32(24, true);
let offset = 12;
while (wav.toString('ascii', offset, offset + 4) !== 'data') {
  offset += 8 + view.getUint32(offset + 4, true);
}
const pcm = wav.subarray(offset + 8);

const chunkBytes = (rate * 2) / 10; // 100 ms
const audio = new ReadableStream({
  async start(controller) {
    for (let i = 0; i < pcm.length; i += chunkBytes) {
      controller.enqueue(pcm.subarray(i, i + chunkBytes));
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    controller.close();
  },
});

const result = streamTranscribe({
  model: speechmatics.transcription(model),
  audio,
  inputAudioFormat: { type: 'audio/pcm', rate },
  providerOptions: { speechmatics: { diarization: 'speaker' } },
});

for await (const part of result.fullStream) {
  if (part.type === 'transcript-partial') {
    process.stdout.write(`\r… ${part.text.slice(-100)}`.padEnd(104));
  }
  if (part.type === 'transcript-final') {
    const { speaker, endOfTurn } = part.providerMetadata?.speechmatics ?? {};
    console.log(
      `\r${part.startSecond.toFixed(2)}s ${speaker ?? ''} ${part.text}${endOfTurn ? '  [end of turn]' : ''}`.padEnd(104),
    );
  }
}

console.log('\nTEXT:', await result.text);
console.log('DURATION:', await result.durationInSeconds);
console.log('PROVIDER METADATA:', await result.providerMetadata);
console.log('WARNINGS:', await result.warnings);
