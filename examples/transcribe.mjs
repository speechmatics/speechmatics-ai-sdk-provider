// Usage: SPEECHMATICS_API_KEY=... node examples/transcribe.mjs <file-or-url> [language] [model]
import { readFile } from 'node:fs/promises';
import { transcribe } from 'ai';
import { speechmatics } from '../dist/index.js';

const [source, language = 'en', model = 'enhanced'] = process.argv.slice(2);
if (!source) {
  console.error('Pass an audio file path or http(s) URL');
  process.exit(1);
}

const audio = /^https?:\/\//.test(source)
  ? new URL(source)
  : await readFile(source);

const result = await transcribe({
  model: speechmatics.transcription(model),
  audio,
  providerOptions: { speechmatics: { language, diarization: 'speaker' } },
});

console.log('TEXT:', result.text);
console.log('LANGUAGE:', result.language);
console.log('DURATION:', result.durationInSeconds);
console.log('SEGMENTS:', result.segments.slice(0, 3));
console.log('WORDS:', result.words?.slice(0, 5));
console.log('PROVIDER METADATA:', result.providerMetadata);
console.log('WARNINGS:', result.warnings);
