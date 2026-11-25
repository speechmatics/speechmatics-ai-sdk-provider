# Speechmatics provider for the Vercel AI SDK

[Speechmatics](https://www.speechmatics.com) speech-to-text provider for the
[Vercel AI SDK](https://ai-sdk.dev).

> **Beta.** Batch and streaming transcription are available. Streaming uses the
> AI SDK's `experimental_streamTranscribe`, which may change in patch releases
> of the AI SDK. Feedback is welcome in
> [GitHub issues](https://github.com/speechmatics/speechmatics-ai-sdk-provider/issues)
> or on [Discord](https://discord.com/invite/speechmatics).

## Installation

```bash
npm install @speechmatics/ai-sdk-provider@beta ai
```

Requires `ai` 7 or later. On the server, requires Node.js 22 or later. Streaming
also runs in the browser; see [Streaming in the browser](#streaming-in-the-browser).

## Skill for Coding Agents

If you use coding agents such as Claude Code or Cursor, add the AI SDK skill to
your repository:

```bash
npx skills add vercel/ai
```

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

Batch accepts wav, mp3, aac, ogg, mpeg, amr, m4a, mp4 and flac files. See
[supported file types](https://docs.speechmatics.com/speech-to-text/batch/input#supported-file-types).

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

Audio must be raw, in one of these formats:

- `audio/pcm`: 16-bit little-endian PCM.
- `audio/pcmu`: G.711 µ-law, as used in telephony.
- `audio/pcma`: G.711 A-law.

Every model accepts all three. `enhanced`, `standard` and `melia-1` accept any
sample rate; `linden-1` accepts 8000 or 16000 Hz only. Audio is not resampled,
so `rate` must be the real sample rate of the audio. Other formats and rates
throw `InvalidArgumentError` before connecting. Chunks can be `Uint8Array`s or
base64 strings.

Results arrive as `transcript-partial` parts, which later parts may revise, and
`transcript-final` parts, which are settled. Set `enablePartials: false` to get
final results only.

Each part has `text` and `startSecond`. Partials add `durationInSeconds`, and
finals add `endSecond`. All times are in seconds from the start of the audio.
`providerMetadata.speechmatics` depends on the model:

```ts
// enhanced, standard and melia-1: final parts only
{
  words: [
    {
      text: 'Hello',
      startSecond: 0.5,
      endSecond: 0.82,
      confidence: 0.99,
      speaker: 'S1', // with diarization: 'speaker'
      language: 'en', // melia-1 only
    },
  ],
  endOfUtterance: true, // when endOfUtteranceSilenceTrigger is above 0
}

// linden-1: partial and final parts, each one segment of speech
{
  speaker: 'S1', // with diarization: 'speaker'
  startOfTurn: true, // first part of a turn only
  endOfTurn: true, // final parts only
}
```

The AI SDK types provider metadata as plain JSON. Cast it to the exported types
to read it:

```ts
import type { SpeechmaticsStreamPartMetadata } from '@speechmatics/ai-sdk-provider';

const metadata = part.providerMetadata?.speechmatics as
  | SpeechmaticsStreamPartMetadata
  | undefined;
```

The flags mark turns and utterances:

| Flag | Model | On | Meaning |
| --- | --- | --- | --- |
| `startOfTurn` | `linden-1` | The first part of a turn, partial or final | Someone has started speaking. Use it to interrupt a voice agent that is talking. Only present when `true`. Arrives with the first partial, so keep `enablePartials` on (the default) when you use it for interruptions. |
| `endOfTurn` | `linden-1` | Every final part | `true` when the part ends the speaker's turn, the cue for a voice agent to respond. |
| `endOfUtterance` | `enhanced`, `standard` | Every final part, when `endOfUtteranceSilenceTrigger` is above 0 | `true` when the part is followed by the set length of silence. |

To set these flags, a final part is held for up to 50 ms until Speechmatics
confirms whether the turn or utterance ended. `melia-1` final parts, and
`enhanced` and `standard` final parts unless `endOfUtteranceSilenceTrigger` is
above 0, are not held and carry no flag.

When the stream finishes, `result.providerMetadata` holds the session id, speaker
turns and any warnings Speechmatics sent; see [Extra results](#extra-results).
Pass `includeRawChunks: true` to also receive every Speechmatics message as a
`raw` part, including turn and utterance events.

### Errors, cancelling and limits

- If Speechmatics rejects the session or reports an error, the stream errors:
  iterating `fullStream` throws, and `result.text` and the other promises
  reject. The message includes Speechmatics' error type and reason, e.g.
  `Speechmatics streaming error (protocol_error): ...`.
- If the connection closes before the transcript finishes, the stream errors
  with the close code and reason.
- If no speech is recognised, the AI SDK ends the stream with
  `NoTranscriptGeneratedError`, both when iterating `fullStream` and from
  `result.text`.
- To stop a session, pass an `abortSignal` or stop reading `fullStream` (e.g.
  `break` out of the loop). The connection is closed straight away.
- Options a model does not support are left out of the request, and listed in
  `await result.warnings`. See [Options](#options).
- Each open session counts towards your account's
  [limit on concurrent sessions](https://docs.speechmatics.com/speech-to-text/realtime/limits).
  Close sessions you no longer need.

### Streaming in the browser

The provider never sends your API key over the WebSocket. Before each session it
exchanges the key for a temporary key that lasts 60 seconds. In the browser,
where the API key must stay secret, create the temporary key on your server
instead:

```ts
// On your server, e.g. an API route
import { createTemporaryKey } from '@speechmatics/ai-sdk-provider';

export async function POST(request: Request) {
  // Replace with your own sign-in check.
  if (!(await isSignedIn(request))) {
    return new Response('Unauthorized', { status: 401 });
  }
  return Response.json({ key: await createTemporaryKey() });
}
```

Always check who is asking before you return a key. Anyone who gets a key can
transcribe on your account, and an open route lets anyone ask for a new key
whenever the last one expires.

A key can start any number of sessions until it expires, and sessions it starts
keep running after that. `createTemporaryKey({ ttl })` sets its lifetime in
seconds, from 60 to 86400. Keep it short: the key only needs to last until the
session starts. A key works with every model and region, including a regional
`realtimeBaseURL`.

On the server, the provider creates a key the same way before each session.
This adds one HTTPS request, about 30 ms, before the connection opens.

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
See [Models](https://docs.speechmatics.com/speech-to-text/models) in the
Speechmatics docs for details.

| Model | Batch | Streaming | Use it for |
| --- | --- | --- | --- |
| `enhanced` | Yes | Yes | Highest accuracy on single-language audio. |
| `standard` | Yes | Yes | Lower latency and higher throughput. |
| `melia-1` | Yes | Yes | Audio with more than one language. |
| `linden-1` | No | Yes | Voice agents: fast results, speaker segments and end-of-turn detection. |

Using `linden-1` with `transcribe` throws `UnsupportedFunctionalityError`. Any
other model name throws `NoSuchModelError`.

## Options

Pass these under `providerOptions.speechmatics`:

| Option | Description |
| --- | --- |
| `language` | [Language code](https://docs.speechmatics.com/speech-to-text/languages) of the audio. Defaults to `en`, or `multi` for `melia-1`. |
| `domain` | Specialised model, e.g. [`medical`](https://docs.speechmatics.com/speech-to-text/models#healthcare-domain), or `bilingual-en` for [Spanish and English](https://docs.speechmatics.com/speech-to-text/languages#bilingual-and-multi-language-packs) with `language: 'es'`. |
| `outputLocale` | [Locale for the transcript output](https://docs.speechmatics.com/speech-to-text/formatting#output-locale), e.g. `en-GB`. |
| `diarization` | [Diarization](https://docs.speechmatics.com/speech-to-text/features/diarization): `none`, `speaker` or `channel`. Speaker turns are returned in `providerMetadata.speechmatics.utterances`. |
| `additionalVocab` | [Custom words](https://docs.speechmatics.com/speech-to-text/features/custom-dictionary), with optional `soundsLike` pronunciations. |
| `enableEntities` | Include entities such as dates and numbers. They are returned in `providerMetadata.speechmatics.entities`. |
| `enablePartials` | Send non-final results. Defaults to `true`. |
| `maxDelay` | Longest wait in seconds for a final result, from 0.7 to 4. Lower is faster but less accurate. Defaults to 4. |
| `endOfUtteranceSilenceTrigger` | Seconds of silence, up to 2, after which an [utterance ends](https://docs.speechmatics.com/speech-to-text/realtime/turn-detection). Above 0, it turns on the `endOfUtterance` flag. |
| `pollingIntervalMs` | How often to check whether a longer job has finished, in milliseconds. Defaults to 5000. |
| `timeoutMs` | Time limit for the whole call, in milliseconds. Defaults to 15 minutes. |

Not every option works everywhere. An option that does not apply is left out of
the request, and a warning is added to `result.warnings`:

| Option | Batch: `enhanced`, `standard`, `melia-1` | Streaming: `enhanced`, `standard` | Streaming: `melia-1` | Streaming: `linden-1` |
| --- | --- | --- | --- | --- |
| `language` | ✓ | ✓ | ✓ | ✓ |
| `domain` | ✓ | ✓ | ✗ | ✓ |
| `outputLocale` | ✓ | ✓ | ✓ | ✓ |
| `diarization` | ✓ | `speaker` only | `speaker` only | `speaker` only |
| `additionalVocab` | ✓, not `melia-1`¹ | ✓ | ✗ | ✓ |
| `enableEntities` | ✓, not `melia-1`¹ | ✓ | ✗ | ✗ |
| `enablePartials` | ✗ | ✓ | ✓ | ✓ |
| `maxDelay` | ✗ | ✓ | ✗ | ✗ |
| `endOfUtteranceSilenceTrigger` | ✗ | ✓ | ✗ | ✗ |
| `pollingIntervalMs` | ✓ | ✗ | ✗ | ✗ |
| `timeoutMs` | ✓ | ✗ | ✗ | ✗ |

¹ In batch, `additionalVocab` and `enableEntities` are still sent with
`melia-1`, with a warning: Speechmatics may reject the job or ignore them.
`melia-1` does not support custom vocabulary, and accepts entities only with
Entity Detection, which this package does not expose yet.

## Extra results

Speaker turns and entities do not fit the AI SDK result shape, so they are in
`providerMetadata.speechmatics`. All times are in seconds. Cast it to
`SpeechmaticsTranscriptionMetadata` (batch) or `SpeechmaticsStreamMetadata`
(streaming) to read it.

```ts
// Batch: transcribe()
const { providerMetadata } = await transcribe({ /* ... */ });
providerMetadata?.speechmatics;
// {
//   jobId: 'r6c9cmmpdr',
//   utterances: [{ speaker: 'S1', text, startSecond, endSecond }], // with diarization
//   entities: [{ entityClass: 'date', text, startSecond, endSecond }], // with enableEntities
// }

// Streaming: experimental_streamTranscribe()
const result = streamTranscribe({ /* ... */ });
await result.providerMetadata;
// {
//   speechmatics: {
//     sessionId: '56cbf3b6-a2da-4083-aa23-f7f356c1899b',
//     utterances: [{ speaker: 'S1', text, startSecond, endSecond }], // with diarization
//     entities: [...], // with enableEntities
//     warnings: [...], // Warning messages Speechmatics sent during the session
//   },
// }
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

## Examples

[`examples/`](examples) has two scripts that run against the Speechmatics API:

- [`transcribe.mjs`](examples/transcribe.mjs) transcribes a file or URL in
  batch.
- [`stream-transcribe.mjs`](examples/stream-transcribe.mjs) streams a 16-bit
  PCM WAV file at real time, as a microphone would, and prints partials,
  finals and turn flags as they arrive.

To run them from a clone of this repository:

```bash
npm install
npm install --no-save ai@7
npm run build
SPEECHMATICS_API_KEY=... node examples/transcribe.mjs meeting.mp3 en enhanced
SPEECHMATICS_API_KEY=... node examples/stream-transcribe.mjs call.wav linden-1
```

## Speechmatics API reference

- [Realtime API](https://docs.speechmatics.com/api-ref/realtime-transcription-websocket),
  used by `enhanced`, `standard` and `melia-1` when streaming.
- [Agent STT API](https://docs.speechmatics.com/api-ref/agent-stt-websocket),
  used by `linden-1`. See also the
  [Agent STT overview](https://docs.speechmatics.com/speech-to-text/agent-stt/).
- [Batch API](https://docs.speechmatics.com/api-ref/batch/create-a-new-job),
  used by `transcribe`.

## Feedback and support

This package is in beta, and feedback shapes the 1.0 release.

- Bugs and feature requests:
  [GitHub issues](https://github.com/speechmatics/speechmatics-ai-sdk-provider/issues)
- Questions and discussion: the
  [Speechmatics Discord](https://discord.com/invite/speechmatics)

## Licence

MIT
