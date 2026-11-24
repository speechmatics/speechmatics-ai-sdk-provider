// Streaming transcription over the Speechmatics Realtime API (`/v2`) and, for
// `linden-1`, the Agent STT API (`/v2/agent`). Both share the session flow:
// StartRecognition -> RecognitionStarted -> binary audio -> EndOfStream ->
// EndOfTranscript. They differ in results: Realtime sends words
// (`AddTranscript`), Agent STT sends speaker segments (`AddSegment`) and turns.

import {
  InvalidArgumentError,
  type Experimental_TranscriptionModelV4StreamPart as TranscriptionModelV4StreamPart,
  type SharedV4Warning,
  type TranscriptionModelV4,
} from '@ai-sdk/provider';
import {
  connectToWebSocket,
  convertBase64ToUint8Array,
  lazySchema,
  parseProviderOptions,
  safeParseJSON,
  validateTypes,
  waitForWebSocketBufferDrain,
  zodSchema,
  type WebSocketConnection,
  type WebSocketLike,
} from '@ai-sdk/provider-utils';
import { z } from 'zod/v4';
import { decodeAlaw, decodeMulaw } from './g711';
import type { SpeechmaticsConfig } from './speechmatics-config';
import type {
  SpeechmaticsStreamMetadata,
  SpeechmaticsStreamPartMetadata,
  SpeechmaticsUtterance,
  SpeechmaticsWord,
} from './speechmatics-provider-metadata';
import {
  buildTranscript,
  type SpeechmaticsResultItem,
} from './speechmatics-transcript';
import { speechmaticsTranscriptionModelOptionsSchema } from './speechmatics-transcription-model-options';
import type { SpeechmaticsTranscriptionModelId } from './speechmatics-transcription-options';

type StreamOptions = Parameters<
  NonNullable<TranscriptionModelV4['doStream']>
>[0];
type StreamResult = Awaited<
  ReturnType<NonNullable<TranscriptionModelV4['doStream']>>
>;

const AGENT_MODEL = 'linden-1';
const MULTILINGUAL_MODEL = 'melia-1';
const DEFAULT_LANGUAGE = 'en';
const MULTILINGUAL_LANGUAGE = 'multi';
const AGENT_SAMPLE_RATES = [8000, 16000];

// Options each model rejects for streaming, found by testing against the live
// API. `linden-1` detects turns itself; `melia-1` accepts few options.
const UNSUPPORTED_OPTIONS: Record<
  string,
  Array<
    | 'domain'
    | 'additionalVocab'
    | 'enableEntities'
    | 'maxDelay'
    | 'endOfUtteranceSilenceTrigger'
  >
> = {
  'melia-1': [
    'domain',
    'additionalVocab',
    'enableEntities',
    'maxDelay',
    'endOfUtteranceSilenceTrigger',
  ],
  'linden-1': ['enableEntities', 'maxDelay', 'endOfUtteranceSilenceTrigger'],
};

// Agent STT sends `EndOfTurn`, and Realtime sends `EndOfUtterance`, straight
// after the final result that closes the turn or utterance. A final is held
// until the next result or this long, so it can be marked `endOfTurn` or
// `endOfUtterance`.
const FINAL_HOLD_MS = 50;

// `encoding` is what the Realtime API accepts natively; Agent STT accepts
// `pcm_s16le` only. Anything else is decoded to `pcm_s16le` before sending.
const INPUT_FORMATS: Record<
  string,
  {
    bytesPerSample: number;
    encoding?: 'pcm_s16le' | 'mulaw';
    decode?: (bytes: Uint8Array) => Uint8Array;
  }
> = {
  'audio/pcm': { bytesPerSample: 2, encoding: 'pcm_s16le' },
  'audio/pcmu': { bytesPerSample: 1, encoding: 'mulaw', decode: decodeMulaw },
  'audio/pcma': { bytesPerSample: 1, decode: decodeAlaw },
};

const TRANSCRIPT_MESSAGES = [
  'AddPartialTranscript',
  'AddTranscript',
  'AddPartialSegment',
  'AddSegment',
];

type Segment = { text: string; startSecond: number; endSecond: number };

export async function streamSpeechmaticsTranscription(
  modelId: SpeechmaticsTranscriptionModelId,
  config: SpeechmaticsConfig & { _internal?: { currentDate?: () => Date } },
  options: StreamOptions,
): Promise<StreamResult> {
  const agent = modelId === AGENT_MODEL;
  const multilingual = modelId === MULTILINGUAL_MODEL;

  const format = INPUT_FORMATS[options.inputAudioFormat.type];
  const rate = options.inputAudioFormat.rate;
  if (format == null) {
    throw new InvalidArgumentError({
      argument: 'inputAudioFormat',
      message: `Speechmatics streaming supports audio/pcm (16-bit little-endian), audio/pcmu and audio/pcma. Got ${options.inputAudioFormat.type}.`,
    });
  }
  if (rate == null || !Number.isInteger(rate) || rate <= 0) {
    throw new InvalidArgumentError({
      argument: 'inputAudioFormat',
      message:
        'Speechmatics streaming requires a positive integer sample rate.',
    });
  }
  if (agent && !AGENT_SAMPLE_RATES.includes(rate)) {
    throw new InvalidArgumentError({
      argument: 'inputAudioFormat',
      message: `${modelId} supports audio/pcm, audio/pcmu and audio/pcma at sample rates of ${AGENT_SAMPLE_RATES.join(' or ')} Hz. Got ${rate}.`,
    });
  }
  const sendsNative =
    format.encoding === 'pcm_s16le' || (!agent && format.encoding != null);
  const encoding = sendsNative ? format.encoding! : 'pcm_s16le';
  const decode = sendsNative ? undefined : format.decode!;

  const providerOptions = await parseProviderOptions({
    provider: 'speechmatics',
    providerOptions: options.providerOptions,
    schema: speechmaticsTranscriptionModelOptionsSchema,
  });
  const warnings: SharedV4Warning[] = [];
  // The server rejects the whole session over one field it does not accept, so
  // unsupported options are dropped with a warning instead of sent.
  const unsupported = UNSUPPORTED_OPTIONS[modelId] ?? [];
  const supports = (key: (typeof UNSUPPORTED_OPTIONS)[string][number]) => {
    if (providerOptions?.[key] == null) return false;
    if (!unsupported.includes(key)) return true;
    warnings.push({
      type: 'unsupported',
      feature: `providerOptions.speechmatics.${key}`,
      details: `${modelId} does not support ${key} for streaming transcription.`,
    });
    return false;
  };

  const language =
    providerOptions?.language ??
    (multilingual ? MULTILINGUAL_LANGUAGE : DEFAULT_LANGUAGE);
  const transcriptionConfig: Record<string, unknown> = {
    language,
    model: modelId,
    enable_partials: providerOptions?.enablePartials ?? true,
  };

  if (supports('domain')) {
    transcriptionConfig.domain = providerOptions!.domain;
  }
  if (providerOptions?.outputLocale != null) {
    transcriptionConfig.output_locale = providerOptions.outputLocale;
  }
  if (providerOptions?.diarization === 'channel') {
    warnings.push({
      type: 'unsupported',
      feature: 'providerOptions.speechmatics.diarization',
      details:
        'Channel diarization is not supported for streaming transcription.',
    });
  } else if (providerOptions?.diarization != null) {
    transcriptionConfig.diarization = providerOptions.diarization;
  }
  if (supports('additionalVocab')) {
    transcriptionConfig.additional_vocab =
      providerOptions!.additionalVocab!.map(entry => ({
        content: entry.content,
        ...(entry.soundsLike != null ? { sounds_like: entry.soundsLike } : {}),
      }));
  }
  if (supports('enableEntities')) {
    transcriptionConfig.enable_entities = providerOptions!.enableEntities;
  }
  if (supports('maxDelay')) {
    transcriptionConfig.max_delay = providerOptions!.maxDelay;
  }
  let markEndOfUtterance = false;
  if (supports('endOfUtteranceSilenceTrigger')) {
    transcriptionConfig.conversation_config = {
      end_of_utterance_silence_trigger:
        providerOptions!.endOfUtteranceSilenceTrigger,
    };
    markEndOfUtterance = providerOptions!.endOfUtteranceSilenceTrigger! > 0;
  }
  for (const key of ['pollingIntervalMs', 'timeoutMs'] as const) {
    if (providerOptions?.[key] != null) {
      warnings.push({
        type: 'unsupported',
        feature: `providerOptions.speechmatics.${key}`,
        details: 'This option only applies to batch transcription.',
      });
    }
  }

  const startRecognition = {
    message: 'StartRecognition',
    audio_format: { type: 'raw', encoding, sample_rate: rate },
    transcription_config: transcriptionConfig,
  };

  // Browsers cannot set headers on a WebSocket, so every session authenticates
  // with a temporary key in the URL. It is created per session and expires
  // quickly, so the API key itself never travels in a URL.
  const temporaryKey = await config.getTemporaryKey!({
    abortSignal: options.abortSignal,
  });
  const url = new URL(
    config.realtimeUrl!({ path: agent ? '/v2/agent' : '/v2' }),
  );
  url.searchParams.set('jwt', temporaryKey);

  // Finals are held to be marked with the message that may follow them.
  const hold = agent
    ? ({ flag: 'endOfTurn', message: 'EndOfTurn' } as const)
    : markEndOfUtterance
      ? ({ flag: 'endOfUtterance', message: 'EndOfUtterance' } as const)
      : undefined;

  const timestamp = config._internal?.currentDate?.() ?? new Date();
  let finished = false;
  let cleanup: () => void = () => {};

  return {
    request: { body: startRecognition },
    response: { timestamp, modelId },
    stream: new ReadableStream<TranscriptionModelV4StreamPart>({
      start(controller) {
        let connection: WebSocketConnection | undefined;
        let reader:
          ReadableStreamDefaultReader<Uint8Array | string> | undefined;
        let seqNo = 0;
        let audioBytes = 0;
        let sessionId: string | undefined;
        let wordDelimiter = ' ';
        const results: SpeechmaticsResultItem[] = [];
        const segments: Array<Segment & { speaker?: string }> = [];
        const serverWarnings: NonNullable<
          SpeechmaticsStreamMetadata['warnings']
        > = [];
        // The start time from `StartOfTurn`, until a part of that turn carries it.
        let turnStart: number | undefined;
        let pendingFinal:
          | {
              part: FinalPart;
              timer: ReturnType<typeof setTimeout>;
            }
          | undefined;

        const flushFinal = (value: boolean) => {
          if (pendingFinal == null || hold == null || finished) return;
          const { part, timer } = pendingFinal;
          pendingFinal = undefined;
          clearTimeout(timer);
          controller.enqueue({
            ...part,
            providerMetadata: {
              speechmatics: {
                ...(part.providerMetadata?.speechmatics ?? {}),
                [hold.flag]: value,
              },
            },
          });
        };

        const emitFinal = (part: FinalPart) => {
          // The stream may have ended while this message was being validated.
          if (finished) return;
          if (hold == null) return controller.enqueue(part);
          flushFinal(false);
          pendingFinal = {
            part,
            timer: setTimeout(() => flushFinal(false), FINAL_HOLD_MS),
          };
        };

        // Speaker and turn start metadata for an Agent STT part. A late final
        // from the previous turn ends before the new turn starts, so it is
        // not marked.
        const segmentMetadata = (
          speaker: string | null | undefined,
          endSecond: number,
        ) => {
          const metadata: SpeechmaticsStreamPartMetadata = {};
          if (speaker != null) metadata.speaker = speaker;
          if (turnStart != null && endSecond > turnStart) {
            metadata.startOfTurn = true;
            turnStart = undefined;
          }
          return Object.keys(metadata).length > 0
            ? { providerMetadata: { speechmatics: metadata } }
            : {};
        };

        cleanup = () => {
          if (pendingFinal != null) clearTimeout(pendingFinal.timer);
          pendingFinal = undefined;
          void (
            reader != null ? reader.cancel() : options.audio.cancel()
          ).catch(() => {});
          connection?.close(1000);
        };
        const fail = (error: unknown) => {
          if (finished) return;
          finished = true;
          controller.error(error);
          cleanup();
        };
        const finish = () => {
          if (finished) return;
          flushFinal(false);
          finished = true;

          const durationInSeconds = audioBytes / (rate * format.bytesPerSample);
          let text: string;
          let finalSegments: Segment[];
          const metadata: SpeechmaticsStreamMetadata = {};
          if (sessionId != null) metadata.sessionId = sessionId;

          if (agent) {
            text = segments.map(segment => segment.text).join(wordDelimiter);
            finalSegments = segments.map(
              ({ text, startSecond, endSecond }) => ({
                text,
                startSecond,
                endSecond,
              }),
            );
            const utterances = segments.filter(
              (segment): segment is SpeechmaticsUtterance =>
                segment.speaker != null,
            );
            if (utterances.length > 0) metadata.utterances = utterances;
          } else {
            const transcript = buildTranscript(results, wordDelimiter, {
              includeSpeakers: providerOptions?.diarization === 'speaker',
            });
            text = transcript.text;
            finalSegments = transcript.segments;
            if (transcript.utterances != null) {
              metadata.utterances = transcript.utterances;
            }
            if (transcript.entities != null) {
              metadata.entities = transcript.entities;
            }
          }
          if (serverWarnings.length > 0) metadata.warnings = serverWarnings;

          controller.enqueue({
            type: 'finish',
            text,
            segments: finalSegments,
            language,
            durationInSeconds,
            usage: { seconds: durationInSeconds },
            providerMetadata: { speechmatics: metadata },
          });
          controller.close();
          cleanup();
        };

        const sendAudio = async (socket: WebSocketLike) => {
          reader = options.audio.getReader();
          try {
            while (true) {
              if (finished) break;
              const { done, value } = await reader.read();
              if (done || finished) break;
              const bytes =
                typeof value === 'string'
                  ? convertBase64ToUint8Array(value)
                  : value;
              if (bytes.byteLength === 0) continue;
              socket.send(decode != null ? decode(bytes) : bytes);
              seqNo++;
              audioBytes += bytes.byteLength;
              await waitForWebSocketBufferDrain(socket, {
                abortSignal: options.abortSignal,
              });
            }
          } finally {
            reader.releaseLock();
            reader = undefined;
          }
          if (!finished) {
            socket.send(
              JSON.stringify({ message: 'EndOfStream', last_seq_no: seqNo }),
            );
          }
        };

        connection = connectToWebSocket({
          url,
          webSocket: config.webSocket,
          abortSignal: options.abortSignal,
          onAbort: fail,
          onProcessingError: fail,
          onOpen(socket) {
            controller.enqueue({ type: 'stream-start', warnings });
            socket.send(JSON.stringify(startRecognition));
          },
          async onMessageText(text) {
            if (finished) return;
            const parsed = await safeParseJSON({
              text,
              schema: messageTypeSchema,
            });
            if (!parsed.success) throw parsed.error;
            if (finished) return;

            const type = parsed.value.message;
            const raw = parsed.rawValue;

            // A held final is settled by the turn or utterance end message, or
            // by the next non-empty result. Other messages, such as
            // `AudioAdded`, `SpeechEnded` or the empty partial that comes just
            // before `EndOfUtterance`, leave it held.
            if (pendingFinal != null) {
              if (type === hold?.message) flushFinal(true);
              else if (TRANSCRIPT_MESSAGES.includes(type) && hasText(raw)) {
                flushFinal(false);
              }
            }

            if (options.includeRawChunks) {
              controller.enqueue({ type: 'raw', rawValue: raw });
            }

            switch (type) {
              case 'RecognitionStarted': {
                const event = await validateTypes({
                  value: raw,
                  schema: recognitionStartedSchema,
                });
                sessionId = event.id ?? undefined;
                wordDelimiter =
                  event.language_pack_info?.word_delimiter ?? wordDelimiter;
                controller.enqueue({
                  type: 'response-metadata',
                  timestamp,
                  modelId,
                  body: raw,
                });
                void sendAudio(connection!.socket!).catch(fail);
                break;
              }

              case 'AddPartialTranscript':
              case 'AddTranscript': {
                const event = await validateTypes({
                  value: raw,
                  schema: transcriptSchema,
                });
                const { start_time, end_time, transcript } = event.metadata;
                if (type === 'AddTranscript') results.push(...event.results);
                if (transcript.trim().length === 0) break;
                if (type === 'AddPartialTranscript') {
                  controller.enqueue({
                    type: 'transcript-partial',
                    text: transcript.trim(),
                    startSecond: start_time,
                    durationInSeconds: end_time - start_time,
                  });
                } else {
                  emitFinal({
                    type: 'transcript-final',
                    text: transcript.trim(),
                    startSecond: start_time,
                    endSecond: end_time,
                    providerMetadata: {
                      speechmatics: { words: toWords(event.results) },
                    },
                  });
                }
                break;
              }

              case 'AddPartialSegment':
              case 'AddSegment': {
                const event = await validateTypes({
                  value: raw,
                  schema: segmentSchema,
                });
                const { start_time, end_time } = event.metadata;
                const { transcript, speaker } = event.segment;
                if (transcript.trim().length === 0) break;
                if (type === 'AddPartialSegment') {
                  controller.enqueue({
                    type: 'transcript-partial',
                    text: transcript,
                    startSecond: start_time,
                    durationInSeconds: end_time - start_time,
                    ...segmentMetadata(speaker, end_time),
                  });
                } else {
                  segments.push({
                    text: transcript,
                    startSecond: start_time,
                    endSecond: end_time,
                    ...(speaker != null ? { speaker } : {}),
                  });
                  emitFinal({
                    type: 'transcript-final',
                    text: transcript,
                    startSecond: start_time,
                    endSecond: end_time,
                    ...segmentMetadata(speaker, end_time),
                  });
                }
                break;
              }

              case 'StartOfTurn': {
                if (!agent) break;
                const event = await validateTypes({
                  value: raw,
                  schema: startOfTurnSchema,
                });
                turnStart = event.metadata?.start_time ?? 0;
                break;
              }

              case 'Warning':
                serverWarnings.push(
                  raw as NonNullable<SpeechmaticsStreamMetadata['warnings']>[number],
                );
                break;

              case 'Error': {
                const event = await validateTypes({
                  value: raw,
                  schema: errorSchema,
                });
                fail(
                  new Error(
                    `Speechmatics streaming error${event.type != null ? ` (${event.type})` : ''}: ${event.reason ?? 'unknown error'}`,
                  ),
                );
                break;
              }

              case 'EndOfTranscript':
                finish();
                break;

              // AudioAdded, Info, LanguageInfo, EndOfUtterance, EndOfTurn,
              // SpeechStarted and SpeechEnded have no stream part of their
              // own. They are available as raw chunks.
            }
          },
          onSocketError: () =>
            fail(new Error('Speechmatics streaming WebSocket error.')),
          onClose({ code, reason }) {
            if (finished) return;
            fail(
              new Error(
                `Speechmatics streaming connection closed before the transcript finished${code != null ? ` (${code})` : ''}${reason ? `: ${reason}` : '.'}`,
              ),
            );
          },
        });
      },
      cancel() {
        if (finished) return;
        finished = true;
        cleanup();
      },
    }),
  };
}

type FinalPart = Extract<
  TranscriptionModelV4StreamPart,
  { type: 'transcript-final' }
>;

// Whether a result message has any text. Read before validation, only to
// decide whether it settles a held final.
function hasText(raw: unknown): boolean {
  const message = raw as {
    metadata?: { transcript?: unknown };
    segment?: { transcript?: unknown };
  };
  const text = message.metadata?.transcript ?? message.segment?.transcript;
  return typeof text === 'string' && text.trim().length > 0;
}

function toWords(results: SpeechmaticsResultItem[]): SpeechmaticsWord[] {
  return results.flatMap(item => {
    const alternative = item.alternatives?.[0];
    if (item.type !== 'word' || alternative == null) return [];
    return [
      {
        text: alternative.content,
        startSecond: item.start_time,
        endSecond: item.end_time,
        ...(alternative.confidence != null
          ? { confidence: alternative.confidence }
          : {}),
        ...(alternative.speaker != null
          ? { speaker: alternative.speaker }
          : {}),
        ...(alternative.language != null
          ? { language: alternative.language }
          : {}),
      },
    ];
  });
}

const messageTypeSchema = lazySchema(() =>
  zodSchema(z.object({ message: z.string() })),
);

const recognitionStartedSchema = lazySchema(() =>
  zodSchema(
    z.object({
      id: z.string().nullish(),
      language_pack_info: z
        .object({ word_delimiter: z.string().nullish() })
        .nullish(),
    }),
  ),
);

const transcriptSchema = lazySchema(() =>
  zodSchema(
    z.object({
      metadata: z.object({
        start_time: z.number(),
        end_time: z.number(),
        transcript: z.string(),
      }),
      results: z.array(
        z.object({
          type: z.string(),
          start_time: z.number(),
          end_time: z.number(),
          is_eos: z.boolean().nullish(),
          attaches_to: z.string().nullish(),
          entity_class: z.string().nullish(),
          alternatives: z
            .array(
              z.object({
                content: z.string(),
                confidence: z.number().nullish(),
                speaker: z.string().nullish(),
                language: z.string().nullish(),
              }),
            )
            .nullish(),
        }),
      ),
    }),
  ),
);

const segmentSchema = lazySchema(() =>
  zodSchema(
    z.object({
      metadata: z.object({ start_time: z.number(), end_time: z.number() }),
      segment: z.object({
        transcript: z.string(),
        speaker: z.string().nullish(),
      }),
    }),
  ),
);

const startOfTurnSchema = lazySchema(() =>
  zodSchema(
    z.object({
      metadata: z.object({ start_time: z.number().nullish() }).nullish(),
    }),
  ),
);

const errorSchema = lazySchema(() =>
  zodSchema(
    z.object({ type: z.string().nullish(), reason: z.string().nullish() }),
  ),
);
