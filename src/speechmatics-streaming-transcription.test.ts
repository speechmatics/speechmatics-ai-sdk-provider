import {
  InvalidArgumentError,
  UnsupportedFunctionalityError,
  type Experimental_TranscriptionModelV4StreamPart as StreamPart,
  type JSONObject,
} from '@ai-sdk/provider';
import type { WebSocketConstructor } from '@ai-sdk/provider-utils';
import { describe, expect, it } from 'vitest';
import { createSpeechmatics } from './speechmatics-provider';
import { createTemporaryKey } from './speechmatics-temporary-key';
import type { SpeechmaticsTranscriptionModelId } from './speechmatics-transcription-options';

type ServerMessage = Record<string, unknown>;

/**
 * A fake Speechmatics server. It answers StartRecognition with
 * RecognitionStarted, and EndOfStream with `results` then EndOfTranscript.
 * `onStart` can replace the StartRecognition answer, e.g. with an Error.
 */
function createFakeServer({
  results = [],
  onStart,
}: {
  results?: ServerMessage[];
  onStart?: (socket: FakeSocket) => void;
} = {}) {
  const sockets: FakeSocket[] = [];

  class FakeSocket {
    readyState = 0;
    bufferedAmount = 0;
    sent: Array<string | Uint8Array> = [];
    closedWith: number | undefined;
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onclose: ((event: unknown) => void) | null = null;

    constructor(
      readonly url: string | URL,
      readonly protocols?: string | string[],
      readonly options?: { headers?: Record<string, string | undefined> },
    ) {
      sockets.push(this);
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.({});
      }, 0);
    }

    get json() {
      return this.sent
        .filter((data): data is string => typeof data === 'string')
        .map(data => JSON.parse(data));
    }

    get audio() {
      return this.sent.filter(
        (data): data is Uint8Array => typeof data !== 'string',
      );
    }

    receive(message: ServerMessage) {
      this.onmessage?.({ data: JSON.stringify(message) });
    }

    send(data: string | Uint8Array) {
      this.sent.push(data);
      if (typeof data !== 'string') return;
      const message = JSON.parse(data);
      if (message.message === 'StartRecognition') {
        if (onStart != null) return onStart(this);
        this.receive({
          message: 'RecognitionStarted',
          id: 'session-1',
          language_pack_info: { word_delimiter: ' ' },
        });
      }
      if (message.message === 'EndOfStream') {
        for (const result of results) this.receive(result);
        this.receive({ message: 'EndOfTranscript' });
      }
    }

    close(code?: number, reason = '') {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.closedWith = code;
      this.onclose?.({ code: code ?? 1005, reason });
    }
  }

  return {
    sockets,
    webSocket: FakeSocket as unknown as WebSocketConstructor,
  };
}

type FakeServer = ReturnType<typeof createFakeServer>;
type FakeSocket = FakeServer['sockets'][number];

function audioStream(chunks: Array<Uint8Array | string>) {
  return new ReadableStream<Uint8Array | string>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<StreamPart>) {
  const parts: StreamPart[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) return parts;
    parts.push(value);
  }
}

async function runStream({
  server = createFakeServer(),
  modelId = 'enhanced',
  chunks = [new Uint8Array(3200)],
  inputAudioFormat = { type: 'audio/pcm', rate: 16000 },
  providerOptions,
  includeRawChunks,
  settings,
}: {
  server?: FakeServer;
  modelId?: SpeechmaticsTranscriptionModelId;
  chunks?: Array<Uint8Array | string>;
  inputAudioFormat?: { type: string; rate?: number };
  providerOptions?: JSONObject;
  includeRawChunks?: boolean;
  settings?: Parameters<typeof createSpeechmatics>[0];
} = {}) {
  const provider = createSpeechmatics({
    apiKey: 'test-key',
    getTemporaryKey: async () => 'temp-key',
    webSocket: server.webSocket,
    ...settings,
  });
  const result = await provider.transcription(modelId).doStream!({
    audio: audioStream(chunks),
    inputAudioFormat,
    providerOptions:
      providerOptions != null ? { speechmatics: providerOptions } : undefined,
    includeRawChunks,
  });
  const parts = await collect(result.stream);
  return { result, parts, socket: server.sockets[0] };
}

const word = (
  content: string,
  start: number,
  end: number,
  extra: Record<string, unknown> = {},
) => ({
  type: 'word',
  start_time: start,
  end_time: end,
  alternatives: [{ content, confidence: 0.9, language: 'en', ...extra }],
});

const fullStop = (time: number) => ({
  type: 'punctuation',
  start_time: time,
  end_time: time,
  attaches_to: 'previous',
  is_eos: true,
  alternatives: [{ content: '.', confidence: 1 }],
});

const segment = (
  message: 'AddSegment' | 'AddPartialSegment',
  transcript: string,
  start: number,
  end: number,
  speaker?: string,
) => ({
  message,
  segment: { transcript, ...(speaker != null ? { speaker } : {}) },
  metadata: { start_time: start, end_time: end },
});

const finishPart = (parts: StreamPart[]) =>
  parts.find(
    (part): part is Extract<StreamPart, { type: 'finish' }> =>
      part.type === 'finish',
  )!;

describe('doStream connection', () => {
  it('connects to the Realtime API with a temporary key and the requested model', async () => {
    const { result, socket } = await runStream();

    const url = new URL(String(socket.url));
    expect(url.origin + url.pathname).toBe(
      'wss://global.rt.speechmatics.com/v2',
    );
    expect(url.searchParams.get('jwt')).toBe('temp-key');
    expect(socket.options?.headers ?? {}).toEqual({});
    expect(socket.json[0]).toEqual({
      message: 'StartRecognition',
      audio_format: { type: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 },
      transcription_config: {
        language: 'en',
        model: 'enhanced',
        enable_partials: true,
      },
    });
    expect(result.request?.body).toEqual(socket.json[0]);
    expect(JSON.stringify(result.request)).not.toContain('temp-key');
  });

  it('connects linden-1 to the Agent STT API', async () => {
    const { socket } = await runStream({ modelId: 'linden-1' });

    expect(new URL(String(socket.url)).pathname).toBe('/v2/agent');
    expect(socket.json[0].transcription_config.model).toBe('linden-1');
  });

  it('uses the realtime base URL from the settings', async () => {
    const { socket } = await runStream({
      settings: { realtimeBaseURL: 'wss://eu.rt.speechmatics.com/' },
    });

    expect(String(socket.url)).toMatch(
      /^wss:\/\/eu\.rt\.speechmatics\.com\/v2\?jwt=/,
    );
  });

  it('creates a temporary key from the API key when none is supplied', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const server = createFakeServer();
    const { socket } = await runStream({
      server,
      settings: {
        getTemporaryKey: undefined,
        apiKey: 'secret-key',
        fetch: async (url, init) => {
          requests.push({ url: String(url), init });
          return new Response(JSON.stringify({ key_value: 'minted-key' }), {
            headers: { 'content-type': 'application/json' },
          });
        },
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://mp.speechmatics.com/v1/jwts?type=rt');
    expect(new Headers(requests[0].init?.headers).get('authorization')).toBe(
      'Bearer secret-key',
    );
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({ ttl: 60 });
    expect(new URL(String(socket.url)).searchParams.get('jwt')).toBe(
      'minted-key',
    );
    expect(String(socket.url)).not.toContain('secret-key');
  });

  it('fails before connecting when the temporary key cannot be created', async () => {
    const server = createFakeServer();
    const provider = createSpeechmatics({
      apiKey: 'bad-key',
      webSocket: server.webSocket,
      fetch: async () =>
        new Response(
          JSON.stringify({ code: 401, error: 'Permission Denied' }),
          {
            status: 401,
            headers: { 'content-type': 'application/json' },
          },
        ),
    });

    await expect(
      provider.transcription('enhanced').doStream!({
        audio: audioStream([]),
        inputAudioFormat: { type: 'audio/pcm', rate: 16000 },
      }),
    ).rejects.toThrow('Permission Denied');
    expect(server.sockets).toHaveLength(0);
  });

  it('sends audio after RecognitionStarted, then EndOfStream with the last sequence number', async () => {
    const order: string[] = [];
    const server = createFakeServer({
      onStart: socket => {
        order.push(`audio before start: ${socket.audio.length}`);
        socket.receive({ message: 'RecognitionStarted', id: 's' });
      },
    });
    const { socket } = await runStream({
      server,
      chunks: [
        new Uint8Array([1, 2]),
        new Uint8Array(0),
        'AwQ=', // base64 of [3, 4]
      ],
    });

    expect(order).toEqual(['audio before start: 0']);
    expect(socket.audio.map(chunk => [...chunk])).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(socket.json.at(-1)).toEqual({
      message: 'EndOfStream',
      last_seq_no: 2,
    });
    expect(socket.closedWith).toBe(1000);
  });
});

describe('doStream audio formats', () => {
  it('sends audio/pcmu as mulaw', async () => {
    const { socket } = await runStream({
      inputAudioFormat: { type: 'audio/pcmu', rate: 8000 },
    });

    expect(socket.json[0].audio_format).toEqual({
      type: 'raw',
      encoding: 'mulaw',
      sample_rate: 8000,
    });
  });

  it.each([
    ['A-law', 'enhanced', { type: 'audio/pcma', rate: 8000 }],
    ['a missing sample rate', 'enhanced', { type: 'audio/pcm' }],
    [
      'a fractional sample rate',
      'enhanced',
      { type: 'audio/pcm', rate: 8000.5 },
    ],
    ['mulaw on linden-1', 'linden-1', { type: 'audio/pcmu', rate: 8000 }],
    ['24 kHz on linden-1', 'linden-1', { type: 'audio/pcm', rate: 24000 }],
  ] as const)('rejects %s before connecting', async (_, modelId, format) => {
    const server = createFakeServer();

    await expect(
      runStream({ server, modelId, inputAudioFormat: format }),
    ).rejects.toThrow(InvalidArgumentError);
    expect(server.sockets).toHaveLength(0);
  });

  it('accepts 8 kHz on linden-1', async () => {
    const { socket } = await runStream({
      modelId: 'linden-1',
      inputAudioFormat: { type: 'audio/pcm', rate: 8000 },
    });

    expect(socket.json[0].audio_format.sample_rate).toBe(8000);
  });
});

describe('doStream options', () => {
  it('maps every option for enhanced', async () => {
    const { parts, socket } = await runStream({
      providerOptions: {
        language: 'de',
        domain: 'finance',
        outputLocale: 'en-GB',
        diarization: 'speaker',
        additionalVocab: [
          { content: 'Speechmatics', soundsLike: ['speech matics'] },
        ],
        enableEntities: true,
        enablePartials: false,
        maxDelay: 1.5,
        endOfUtteranceSilenceTrigger: 0.5,
      },
    });

    expect(socket.json[0].transcription_config).toEqual({
      language: 'de',
      model: 'enhanced',
      enable_partials: false,
      domain: 'finance',
      output_locale: 'en-GB',
      diarization: 'speaker',
      additional_vocab: [
        { content: 'Speechmatics', sounds_like: ['speech matics'] },
      ],
      enable_entities: true,
      max_delay: 1.5,
      conversation_config: { end_of_utterance_silence_trigger: 0.5 },
    });
    expect(parts[0]).toEqual({ type: 'stream-start', warnings: [] });
  });

  it('defaults melia-1 to multi and drops the options it rejects, with warnings', async () => {
    const { parts, socket } = await runStream({
      modelId: 'melia-1',
      providerOptions: {
        domain: 'finance',
        additionalVocab: [{ content: 'Speechmatics' }],
        enableEntities: true,
        maxDelay: 2,
        endOfUtteranceSilenceTrigger: 0.5,
        diarization: 'speaker',
        outputLocale: 'en-GB',
      },
    });

    expect(socket.json[0].transcription_config).toEqual({
      language: 'multi',
      model: 'melia-1',
      enable_partials: true,
      diarization: 'speaker',
      output_locale: 'en-GB',
    });
    const start = parts[0] as Extract<StreamPart, { type: 'stream-start' }>;
    expect(
      start.warnings.map(w => w.type === 'unsupported' && w.feature),
    ).toEqual([
      'providerOptions.speechmatics.domain',
      'providerOptions.speechmatics.additionalVocab',
      'providerOptions.speechmatics.enableEntities',
      'providerOptions.speechmatics.maxDelay',
      'providerOptions.speechmatics.endOfUtteranceSilenceTrigger',
    ]);
  });

  it('drops the options linden-1 rejects and keeps the rest', async () => {
    const { parts, socket } = await runStream({
      modelId: 'linden-1',
      providerOptions: {
        domain: 'finance',
        additionalVocab: [{ content: 'Speechmatics' }],
        enableEntities: true,
        maxDelay: 2,
        endOfUtteranceSilenceTrigger: 0.5,
      },
    });

    expect(socket.json[0].transcription_config).toEqual({
      language: 'en',
      model: 'linden-1',
      enable_partials: true,
      domain: 'finance',
      additional_vocab: [{ content: 'Speechmatics' }],
    });
    const start = parts[0] as Extract<StreamPart, { type: 'stream-start' }>;
    expect(start.warnings).toHaveLength(3);
  });

  it('drops channel diarization and batch-only options with warnings', async () => {
    const { parts, socket } = await runStream({
      providerOptions: {
        diarization: 'channel',
        pollingIntervalMs: 1000,
        timeoutMs: 1000,
      },
    });

    expect(socket.json[0].transcription_config.diarization).toBeUndefined();
    const start = parts[0] as Extract<StreamPart, { type: 'stream-start' }>;
    expect(
      start.warnings.map(w => w.type === 'unsupported' && w.feature),
    ).toEqual([
      'providerOptions.speechmatics.diarization',
      'providerOptions.speechmatics.pollingIntervalMs',
      'providerOptions.speechmatics.timeoutMs',
    ]);
  });
});

describe('doStream results from the Realtime API', () => {
  const realtimeResults = [
    {
      message: 'AddPartialTranscript',
      metadata: { start_time: 0, end_time: 0.4, transcript: 'Hel' },
      results: [word('Hel', 0, 0.4, { speaker: 'S1' })],
    },
    {
      message: 'AddTranscript',
      metadata: { start_time: 0, end_time: 0.9, transcript: 'Hello world. ' },
      results: [
        word('Hello', 0, 0.4, { speaker: 'S1' }),
        word('world', 0.5, 0.9, { speaker: 'S1' }),
        fullStop(0.9),
      ],
    },
    {
      message: 'AddTranscript',
      metadata: { start_time: 0.9, end_time: 1, transcript: '' },
      results: [],
    },
    { message: 'EndOfUtterance', metadata: { start_time: 1, end_time: 1 } },
    {
      message: 'AddTranscript',
      metadata: { start_time: 1.2, end_time: 1.6, transcript: 'Hi. ' },
      results: [word('Hi', 1.2, 1.6, { speaker: 'S2' }), fullStop(1.6)],
    },
  ];

  it('streams partial and final transcripts, skipping empty ones', async () => {
    const { parts } = await runStream({
      server: createFakeServer({ results: realtimeResults }),
    });

    expect(parts.filter(part => part.type.startsWith('transcript'))).toEqual([
      {
        type: 'transcript-partial',
        text: 'Hel',
        startSecond: 0,
        durationInSeconds: 0.4,
      },
      {
        type: 'transcript-final',
        text: 'Hello world.',
        startSecond: 0,
        endSecond: 0.9,
        providerMetadata: {
          speechmatics: {
            words: [
              {
                text: 'Hello',
                startSecond: 0,
                endSecond: 0.4,
                confidence: 0.9,
                speaker: 'S1',
                language: 'en',
              },
              {
                text: 'world',
                startSecond: 0.5,
                endSecond: 0.9,
                confidence: 0.9,
                speaker: 'S1',
                language: 'en',
              },
            ],
          },
        },
      },
      expect.objectContaining({ type: 'transcript-final', text: 'Hi.' }),
    ]);
  });

  it('finishes with the full transcript, sentence segments and speaker turns', async () => {
    const { parts } = await runStream({
      server: createFakeServer({ results: realtimeResults }),
      chunks: [new Uint8Array(32000), new Uint8Array(16000)],
      providerOptions: { diarization: 'speaker' },
    });

    expect(finishPart(parts)).toEqual({
      type: 'finish',
      text: 'Hello world. Hi.',
      segments: [
        { text: 'Hello world.', startSecond: 0, endSecond: 0.9 },
        { text: 'Hi.', startSecond: 1.2, endSecond: 1.6 },
      ],
      language: 'en',
      durationInSeconds: 1.5,
      usage: { seconds: 1.5 },
      providerMetadata: {
        speechmatics: {
          sessionId: 'session-1',
          utterances: [
            {
              speaker: 'S1',
              text: 'Hello world.',
              startSecond: 0,
              endSecond: 0.9,
            },
            { speaker: 'S2', text: 'Hi.', startSecond: 1.2, endSecond: 1.6 },
          ],
        },
      },
    });
    expect(parts.at(-1)?.type).toBe('finish');
  });

  it('reports the session in response metadata', async () => {
    const { parts } = await runStream();

    expect(parts[1]).toEqual(
      expect.objectContaining({
        type: 'response-metadata',
        modelId: 'enhanced',
        body: expect.objectContaining({ id: 'session-1' }),
      }),
    );
  });

  it('passes every server message through as raw chunks when asked', async () => {
    const { parts } = await runStream({
      server: createFakeServer({ results: realtimeResults }),
      includeRawChunks: true,
    });

    const raw = parts
      .filter(part => part.type === 'raw')
      .map(part => (part.rawValue as { message: string }).message);
    expect(raw).toContain('EndOfUtterance');
    expect(raw.at(-1)).toBe('EndOfTranscript');
  });

  it('does not emit raw chunks by default', async () => {
    const { parts } = await runStream({
      server: createFakeServer({ results: realtimeResults }),
    });

    expect(parts.some(part => part.type === 'raw')).toBe(false);
  });

  it('collects server warnings into the finish metadata', async () => {
    const warning = {
      message: 'Warning',
      type: 'idle_timeout',
      reason: 'Session will timeout in 15m due to inactivity',
    };
    const { parts } = await runStream({
      server: createFakeServer({ results: [...realtimeResults, warning] }),
    });

    expect(finishPart(parts).providerMetadata?.speechmatics.warnings).toEqual([
      warning,
    ]);
  });
});

describe('doStream results from the Agent STT API', () => {
  it('streams segments with speakers and marks the segment that ends a turn', async () => {
    const { parts } = await runStream({
      modelId: 'linden-1',
      server: createFakeServer({
        results: [
          { message: 'StartOfTurn', metadata: { start_time: 0 } },
          segment('AddPartialSegment', 'Hello', 0, 0.4, 'S1'),
          segment('AddSegment', 'Hello there.', 0, 0.9, 'S1'),
          segment('AddSegment', 'How are you?', 1, 1.8, 'S1'),
          { message: 'EndOfTurn', metadata: { end_time: 1.8 } },
          segment('AddSegment', 'Fine.', 2, 2.4),
        ],
      }),
    });

    expect(parts.filter(part => part.type.startsWith('transcript'))).toEqual([
      {
        type: 'transcript-partial',
        text: 'Hello',
        startSecond: 0,
        durationInSeconds: 0.4,
        providerMetadata: { speechmatics: { speaker: 'S1' } },
      },
      {
        type: 'transcript-final',
        text: 'Hello there.',
        startSecond: 0,
        endSecond: 0.9,
        providerMetadata: { speechmatics: { speaker: 'S1', endOfTurn: false } },
      },
      {
        type: 'transcript-final',
        text: 'How are you?',
        startSecond: 1,
        endSecond: 1.8,
        providerMetadata: { speechmatics: { speaker: 'S1', endOfTurn: true } },
      },
      {
        type: 'transcript-final',
        text: 'Fine.',
        startSecond: 2,
        endSecond: 2.4,
        providerMetadata: { speechmatics: { endOfTurn: false } },
      },
    ]);

    expect(finishPart(parts)).toEqual(
      expect.objectContaining({
        text: 'Hello there. How are you? Fine.',
        segments: [
          { text: 'Hello there.', startSecond: 0, endSecond: 0.9 },
          { text: 'How are you?', startSecond: 1, endSecond: 1.8 },
          { text: 'Fine.', startSecond: 2, endSecond: 2.4 },
        ],
        providerMetadata: {
          speechmatics: {
            sessionId: 'session-1',
            utterances: [
              {
                text: 'Hello there.',
                startSecond: 0,
                endSecond: 0.9,
                speaker: 'S1',
              },
              {
                text: 'How are you?',
                startSecond: 1,
                endSecond: 1.8,
                speaker: 'S1',
              },
            ],
          },
        },
      }),
    );
  });

  it('releases a final segment if no message follows it', async () => {
    const server = createFakeServer({
      onStart: socket => {
        socket.receive({ message: 'RecognitionStarted', id: 's' });
        socket.receive(segment('AddSegment', 'Hello.', 0, 0.5, 'S1'));
      },
    });
    const provider = createSpeechmatics({
      getTemporaryKey: async () => 'temp-key',
      webSocket: server.webSocket,
    });
    // The audio never ends, so the session stays open.
    const result = await provider.transcription('linden-1').doStream!({
      audio: new ReadableStream(),
      inputAudioFormat: { type: 'audio/pcm', rate: 16000 },
    });
    const reader = result.stream.getReader();

    const types: string[] = [];
    while (!types.includes('transcript-final')) {
      types.push((await reader.read()).value!.type);
    }
    expect(types).toEqual([
      'stream-start',
      'response-metadata',
      'transcript-final',
    ]);
    await reader.cancel();
    expect(server.sockets[0].closedWith).toBe(1000);
  });
});

describe('doStream errors', () => {
  it('errors the stream with the type and reason of a server Error', async () => {
    const server = createFakeServer({
      onStart: socket => {
        socket.receive({
          message: 'Error',
          type: 'protocol_error',
          reason:
            "invalid input: transcription_config: additional properties 'max_delay' not allowed",
        });
        socket.close(1003, 'protocol_error');
      },
    });

    await expect(runStream({ server })).rejects.toThrow(
      "Speechmatics streaming error (protocol_error): invalid input: transcription_config: additional properties 'max_delay' not allowed",
    );
  });

  it('errors the stream when the connection closes before EndOfTranscript', async () => {
    const server = createFakeServer({
      onStart: socket => socket.close(4005, 'quota_exceeded'),
    });

    await expect(runStream({ server })).rejects.toThrow(
      'Speechmatics streaming connection closed before the transcript finished (4005): quota_exceeded',
    );
  });

  it('closes the connection when aborted', async () => {
    const server = createFakeServer();
    const controller = new AbortController();
    const provider = createSpeechmatics({
      getTemporaryKey: async () => 'temp-key',
      webSocket: server.webSocket,
    });
    const result = await provider.transcription('enhanced').doStream!({
      audio: new ReadableStream(),
      inputAudioFormat: { type: 'audio/pcm', rate: 16000 },
      abortSignal: controller.signal,
    });
    const reader = result.stream.getReader();
    await reader.read(); // stream-start: the socket is open
    controller.abort(new Error('stop'));

    await expect(
      collect(
        new ReadableStream({
          async pull(c) {
            const { done, value } = await reader.read();
            if (done) c.close();
            else c.enqueue(value);
          },
        }),
      ),
    ).rejects.toThrow('stop');
    expect(server.sockets[0].closedWith).toBe(1000);
  });
});

describe('batch with streaming-only models and options', () => {
  it('rejects linden-1 for batch transcription', async () => {
    const model = createSpeechmatics({ apiKey: 'k' }).transcription('linden-1');

    await expect(
      model.doGenerate({ audio: new Uint8Array(1), mediaType: 'audio/wav' }),
    ).rejects.toThrow(UnsupportedFunctionalityError);
    await expect(
      model.doGenerateFromUrl!({ audio: new URL('https://example.com/a.wav') }),
    ).rejects.toThrow('linden-1 only supports streaming transcription');
  });
});

describe('createTemporaryKey', () => {
  it('exchanges the API key for a realtime temporary key', async () => {
    let request: { url: string; init?: RequestInit } | undefined;

    const key = await createTemporaryKey({
      apiKey: 'secret-key',
      ttl: 300,
      fetch: async (url, init) => {
        request = { url: String(url), init };
        return new Response(JSON.stringify({ key_value: 'temp' }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    expect(key).toBe('temp');
    expect(request?.url).toBe('https://mp.speechmatics.com/v1/jwts?type=rt');
    expect(request?.init?.method).toBe('POST');
    expect(new Headers(request?.init?.headers).get('authorization')).toBe(
      'Bearer secret-key',
    );
    expect(JSON.parse(String(request?.init?.body))).toEqual({ ttl: 300 });
  });
});
