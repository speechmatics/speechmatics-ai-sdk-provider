# Speechmatics provider for the Vercel AI SDK

[Speechmatics](https://www.speechmatics.com) speech-to-text provider for the
[Vercel AI SDK](https://ai-sdk.dev).

> **Status: pre-release.** Batch transcription is implemented. Realtime
> (streaming) transcription is planned and not yet available. This package is
> not yet published to npm.

## Installation

```bash
npm install @speechmatics/ai-sdk-provider ai
```

## Authentication

Set your API key as `SPEECHMATICS_API_KEY`, or pass it explicitly:

```ts
import { createSpeechmatics } from '@speechmatics/ai-sdk-provider';

const speechmatics = createSpeechmatics({ apiKey: process.env.MY_KEY });
```

## Usage

```ts
import { transcribe } from 'ai';
import { speechmatics } from '@speechmatics/ai-sdk-provider';
import { readFile } from 'node:fs/promises';

const { text, segments } = await transcribe({
  model: speechmatics.transcription('enhanced'),
  audio: await readFile('meeting.mp3'),
  providerOptions: {
    speechmatics: {
      language: 'en',
      diarization: 'speaker',
    },
  },
});
```

Audio can also be passed as a URL. Speechmatics fetches `http` and `https` URLs
itself, so large files are not downloaded into your process.

## Options

Pass these under `providerOptions.speechmatics`:

| Option | Description |
| --- | --- |
| `language` | Language code of the audio. Defaults to `en`, or `multi` for `melia-1`. |
| `domain` | Specialised model for a field, e.g. `finance` or `medical`. |
| `outputLocale` | Locale for the transcript output, e.g. `en-GB`. |
| `diarization` | `none`, `speaker` or `channel`. Speaker turns are returned in `providerMetadata.speechmatics.utterances`. |
| `additionalVocab` | Custom words, with optional `soundsLike` pronunciations. |
| `enableEntities` | Include entities such as dates and numbers. They are returned in `providerMetadata.speechmatics.entities`. |
| `pollingIntervalMs` | How often to check job status. Defaults to 5000. |
| `timeoutMs` | How long to wait for the job. Defaults to 15 minutes. |

## Models

Pass the model to `speechmatics.transcription(...)`. The default is `enhanced`.

| Model | Use it for |
| --- | --- |
| `enhanced` | Highest accuracy on single-language audio. |
| `standard` | Lower latency and higher throughput. |
| `melia-1` | Audio with more than one language. |

`melia-1` does not support custom vocabulary, and accepts entities only with
Entity Detection, which this package does not expose yet. Passing
`additionalVocab` or `enableEntities` with it returns a warning.

Any other model name throws `NoSuchModelError`.

## Extra results

Speaker turns and entities do not fit the AI SDK result shape, so they are in
`providerMetadata.speechmatics`. All times are in seconds.

```ts
const { providerMetadata } = await transcribe({ /* ... */ });
providerMetadata?.speechmatics;
// { jobId, utterances: [{ speaker: 'S1', text, startSecond, endSecond }], entities: [...] }
```

## Provider settings

| Setting | Description |
| --- | --- |
| `apiKey` | API key, or a function that returns one. |
| `baseURL` | Batch API base URL. Defaults to `https://asr.api.speechmatics.com`. |
| `headers` | Extra headers to send with every request. |
| `fetch` | Custom `fetch` implementation. |

## Development

```bash
npm install
npm run type-check
npm test        # runs the suite on Node and in the Edge runtime
npm run build
```

Node 24 is recommended (see `.nvmrc`).

## Licence

MIT
