# Speechmatics provider for the Vercel AI SDK

[Speechmatics](https://www.speechmatics.com) speech-to-text provider for the
[Vercel AI SDK](https://ai-sdk.dev).

> **Beta.** Batch and streaming transcription are available. Streaming uses the
> AI SDK's `experimental_streamTranscribe`, which may change in patch releases
> of the AI SDK.

## Installation

```bash
npm install @speechmatics/ai-sdk-provider@beta ai
```

Requires Node.js 22 or later.

## Authentication

Get an API key from the [Speechmatics portal](https://portal.speechmatics.com)
and set it as `SPEECHMATICS_API_KEY`, or pass it explicitly:

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

```ts
const { text } = await transcribe({
  model: speechmatics.transcription('enhanced'),
  audio: new URL('https://example.com/meeting.mp3'),
});
```

## Streaming

Stream live audio, such as a microphone or a phone call, and get results as
they are spoken:

```ts
import { experimental_streamTranscribe as streamTranscribe } from 'ai';
import { speechmatics } from '@speechmatics/ai-sdk-provider';

const result = streamTranscribe({
  model: speechmatics.transcription('linden-1'),
  audio, // ReadableStream of raw audio chunks
  inputAudioFormat: { type: 'audio/pcm', rate: 16000 },
});

for await (const part of result.fullStream) {
  if (part.type === 'transcript-partial') {
    console.log('...', part.text);
  }
  if (part.type === 'transcript-final') {
    console.log(part.text, part.providerMetadata?.speechmatics);
  }
}

console.log(await result.text);
```

Audio must be raw:

- `audio/pcm`: 16-bit little-endian PCM, at any sample rate.
- `audio/pcmu`: µ-law. Not supported by `linden-1`.

`linden-1` accepts 8000 or 16000 Hz only. Other formats throw
`InvalidArgumentError` before connecting.

Results arrive as `transcript-partial` parts, which later parts may revise, and
`transcript-final` parts, which are settled. Set `enablePartials: false` to get
final results only.

- With `enhanced`, `standard` and `melia-1`, each final part carries its words
  in `providerMetadata.speechmatics.words`, with timings, confidence and, with
  diarization, the speaker.
- With `linden-1`, each part is a segment with its speaker in
  `providerMetadata.speechmatics.speaker`. A final part that ends the speaker's
  turn has `endOfTurn: true`, which is the cue for a voice agent to respond.

When the stream finishes, `providerMetadata.speechmatics` holds the session id,
speaker turns (`utterances`) and any warnings Speechmatics sent during the
session. Pass `includeRawChunks: true` to also receive every Speechmatics
message as a `raw` part, including turn and utterance events.

### Streaming in the browser

The provider never sends your API key over the WebSocket. Before each session it
exchanges the key for a temporary key that lasts 60 seconds. In the browser,
where the API key must stay secret, create the temporary key on your server
instead:

```ts
// On your server, e.g. an API route
import { createTemporaryKey } from '@speechmatics/ai-sdk-provider';

export async function POST() {
  return Response.json({ key: await createTemporaryKey() });
}
```

```ts
// In the browser
import { createSpeechmatics } from '@speechmatics/ai-sdk-provider';

const speechmatics = createSpeechmatics({
  getTemporaryKey: async () => {
    const response = await fetch('/api/speechmatics-key', { method: 'POST' });
    return (await response.json()).key;
  },
});
```

## Models

Pass the model to `speechmatics.transcription(...)`. The default is `enhanced`.

| Model | Batch | Streaming | Use it for |
| --- | --- | --- | --- |
| `enhanced` | Yes | Yes | Highest accuracy on single-language audio. |
| `standard` | Yes | Yes | Lower latency and higher throughput. |
| `melia-1` | Yes | Yes | Audio with more than one language. |
| `linden-1` | No | Yes | Voice agents: fast results, speaker segments and end-of-turn detection. |

`melia-1` does not support custom vocabulary, and accepts entities only with
Entity Detection, which this package does not expose yet. Passing
`additionalVocab` or `enableEntities` with it returns a warning.

Options a model does not support for streaming are left out of the request,
with a warning:

- `melia-1`: `domain`, `additionalVocab`, `enableEntities`, `maxDelay`,
  `endOfUtteranceSilenceTrigger`.
- `linden-1`: `enableEntities`, `maxDelay`, `endOfUtteranceSilenceTrigger`.

Using `linden-1` with `transcribe` throws `UnsupportedFunctionalityError`. Any
other model name throws `NoSuchModelError`.

## Options

Pass these under `providerOptions.speechmatics`:

| Option | Description |
| --- | --- |
| `language` | Language code of the audio. Defaults to `en`, or `multi` for `melia-1`. |
| `domain` | Specialised model for a field, e.g. `finance` or `medical`. |
| `outputLocale` | Locale for the transcript output, e.g. `en-GB`. |
| `diarization` | `none`, `speaker` or `channel` (batch only). Speaker turns are returned in `providerMetadata.speechmatics.utterances`. |
| `additionalVocab` | Custom words, with optional `soundsLike` pronunciations. |
| `enableEntities` | Include entities such as dates and numbers. They are returned in `providerMetadata.speechmatics.entities`. |
| `enablePartials` | Streaming only. Send non-final results. Defaults to `true`. |
| `maxDelay` | Streaming only. Longest wait in seconds for a final result, from 0.7 to 4. Lower is faster but less accurate. Defaults to 4. |
| `endOfUtteranceSilenceTrigger` | Streaming only, `enhanced` and `standard`. Seconds of silence, up to 2, after which Speechmatics sends an `EndOfUtterance` message. |
| `pollingIntervalMs` | Batch only. How often to check whether a longer job has finished. Defaults to 5000. |
| `timeoutMs` | Batch only. Time limit for the whole call. Defaults to 15 minutes. |

## Extra results

Speaker turns and entities do not fit the AI SDK result shape, so they are in
`providerMetadata.speechmatics`. All times are in seconds.

```ts
const { providerMetadata } = await transcribe({ /* ... */ });
providerMetadata?.speechmatics;
// { jobId, utterances: [{ speaker: 'S1', text, startSecond, endSecond }], entities: [...] }
```

## Long audio, time limits and cancelling (batch)

Short files are transcribed in a single request. Longer files are checked every
`pollingIntervalMs` until they finish or `timeoutMs` runs out.

If the call times out, is aborted, or fails after the job was created, a job that
is still running is cancelled so it does not keep running. If it had finished in
the meantime, you get the transcript instead of an error. When an error is
thrown, its message says whether the job was cancelled.

Errors thrown after the job was created are not retried automatically, because a
retry would start a second job.

## Provider settings

Pass these to `createSpeechmatics(...)`:

| Setting | Description |
| --- | --- |
| `apiKey` | API key, or a function that returns one. |
| `baseURL` | Batch API base URL. Defaults to `https://asr.api.speechmatics.com`. |
| `realtimeBaseURL` | Streaming base URL. Defaults to `wss://global.rt.speechmatics.com`, which picks the nearest region. Use a regional host such as `wss://eu.rt.speechmatics.com` to keep data in one region. |
| `getTemporaryKey` | Function that returns a temporary key for each streaming session. Use it in the browser. |
| `webSocket` | Custom `WebSocket` implementation for streaming. |
| `headers` | Extra headers to send with every request. |
| `fetch` | Custom `fetch` implementation. |

## Licence

MIT
