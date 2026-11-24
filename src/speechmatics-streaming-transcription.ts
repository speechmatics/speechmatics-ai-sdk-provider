// Streaming transcription over the Speechmatics Realtime API (`/v2`) and, for
// `linden-1`, the Agent STT API (`/v2/agent`). Both share the session flow:
// StartRecognition -> RecognitionStarted -> binary audio -> EndOfStream ->
// EndOfTranscript. They differ in results: Realtime sends words
// (`AddTranscript`), Agent STT sends speaker segments (`AddSegment`) and turns.

import {
  InvalidArgumentError,
  type Experimental_TranscriptionModelV4StreamPart as TranscriptionModelV4StreamPart,
  type JSONObject,
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
import type { SpeechmaticsConfig } from './speechmatics-config';
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

// Agent STT sends `EndOfTurn` straight after the segment that closes the turn.
// A final segment is held this long so it can be marked `endOfTurn`.
const END_OF_TURN_WAIT_MS = 100;

const ENCODINGS: Record<string, { encoding: string; bytesPerSample: number }> =
  {
    'audio/pcm': { encoding: 'pcm_s16le', bytesPerSample: 2 },
    'audio/pcmu': { encoding: 'mulaw', bytesPerSample: 1 },
  };

type Segment = { text: string; startSecond: number; endSecond: number };

export async function streamSpeechmaticsTranscription(
  modelId: SpeechmaticsTranscriptionModelId,
  config: SpeechmaticsConfig & { _internal?: { currentDate?: () => Date } },
  options: StreamOptions,
): Promise<StreamResult> {
  const agent = modelId === AGENT_MODEL;
  const multilingual = modelId === MULTILINGUAL_MODEL;

  const format = ENCODINGS[options.inputAudioFormat.type];
  const rate = options.inputAudioFormat.rate;
  if (format == null) {
    throw new InvalidArgumentError({
      argument: 'inputAudioFormat',
      message: `Speechmatics streaming supports audio/pcm (16-bit little-endian) and audio/pcmu. Got ${options.inputAudioFormat.type}.`,
    });
  }
  if (rate == null || !Number.isInteger(rate) || rate <= 0) {
    throw new InvalidArgumentError({
      argument: 'inputAudioFormat',
      message:
        'Speechmatics streaming requires a positive integer sample rate.',
    });
  }
  if (agent && format.encoding !== 'pcm_s16le') {
    throw new InvalidArgumentError({
      argument: 'inputAudioFormat',
      message: `${modelId} supports audio/pcm only.`,
    });
  }
  if (agent && !AGENT_SAMPLE_RATES.includes(rate)) {
    throw new InvalidArgumentError({
      argument: 'inputAudioFormat',
      message: `${modelId} supports sample rates of ${AGENT_SAMPLE_RATES.join(' or ')} Hz. Got ${rate}.`,
    });
  }

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
  if (supports('endOfUtteranceSilenceTrigger')) {
    transcriptionConfig.conversation_config = {
      end_of_utterance_silence_trigger:
        providerOptions!.endOfUtteranceSilenceTrigger,
    };
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
    audio_format: { type: 'raw', encoding: format.encoding, sample_rate: rate },
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
        const serverWarnings: JSONObject[] = [];
        let pendingSegment:
          | {
              part: Extract<
                TranscriptionModelV4StreamPart,
                { type: 'transcript-final' }
              >;
              timer: ReturnType<typeof setTimeout>;
            }
          | undefined;

        const flushSegment = (endOfTurn: boolean) => {
          if (pendingSegment == null) return;
          const { part, timer } = pendingSegment;
          pendingSegment = undefined;
          clearTimeout(timer);
          controller.enqueue({
            ...part,
            providerMetadata: {
              speechmatics: {
                ...(part.providerMetadata?.speechmatics ?? {}),
                endOfTurn,
              },
            },
          });
        };

        cleanup = () => {
          if (pendingSegment != null) clearTimeout(pendingSegment.timer);
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
          flushSegment(false);
          finished = true;

          const durationInSeconds = audioBytes / (rate * format.bytesPerSample);
          let text: string;
          let finalSegments: Segment[];
          const metadata: JSONObject = {};
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
              segment => segment.speaker != null,
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
              socket.send(bytes);
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

            // Any message after a held segment shows whether it closed the turn.
            if (pendingSegment != null) flushSegment(type === 'EndOfTurn');

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
                  controller.enqueue({
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
                const speakerMetadata =
                  speaker != null ? { speechmatics: { speaker } } : undefined;
                if (type === 'AddPartialSegment') {
                  controller.enqueue({
                    type: 'transcript-partial',
                    text: transcript,
                    startSecond: start_time,
                    durationInSeconds: end_time - start_time,
                    ...(speakerMetadata != null
                      ? { providerMetadata: speakerMetadata }
                      : {}),
                  });
                } else {
                  segments.push({
                    text: transcript,
                    startSecond: start_time,
                    endSecond: end_time,
                    ...(speaker != null ? { speaker } : {}),
                  });
                  pendingSegment = {
                    part: {
                      type: 'transcript-final',
                      text: transcript,
                      startSecond: start_time,
                      endSecond: end_time,
                      ...(speakerMetadata != null
                        ? { providerMetadata: speakerMetadata }
                        : {}),
                    },
                    timer: setTimeout(
                      () => flushSegment(false),
                      END_OF_TURN_WAIT_MS,
                    ),
                  };
                }
                break;
              }

              case 'Warning':
                serverWarnings.push(raw as JSONObject);
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

              // AudioAdded, Info, LanguageInfo, EndOfUtterance, StartOfTurn,
              // EndOfTurn, SpeechStarted and SpeechEnded have no stream part.
              // They are available as raw chunks.
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

function toWords(results: SpeechmaticsResultItem[]): JSONObject[] {
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

const errorSchema = lazySchema(() =>
  zodSchema(
    z.object({ type: z.string().nullish(), reason: z.string().nullish() }),
  ),
);
