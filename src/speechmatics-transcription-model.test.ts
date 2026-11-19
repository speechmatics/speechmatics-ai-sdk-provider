import { APICallError } from '@ai-sdk/provider';
import { describe, expect, it, vi } from 'vitest';
import { createSpeechmatics } from './speechmatics-provider';

const transcript = {
  format: '2.9',
  metadata: {
    transcription_config: { language: 'en' },
    language_pack_info: { word_delimiter: ' ' },
  },
  results: [
    {
      type: 'word',
      start_time: 0,
      end_time: 0.4,
      alternatives: [{ content: 'Hello', confidence: 0.99, language: 'en' }],
    },
    {
      type: 'punctuation',
      start_time: 0.4,
      end_time: 0.4,
      attaches_to: 'previous',
      is_eos: false,
      alternatives: [{ content: ',', confidence: 1, language: 'en' }],
    },
    {
      type: 'word',
      start_time: 0.5,
      end_time: 0.9,
      alternatives: [{ content: 'world', confidence: 0.98, language: 'en' }],
    },
    {
      type: 'punctuation',
      start_time: 0.9,
      end_time: 0.9,
      attaches_to: 'previous',
      is_eos: true,
      alternatives: [{ content: '.', confidence: 1, language: 'en' }],
    },
    {
      type: 'word',
      start_time: 1.2,
      end_time: 1.4,
      alternatives: [{ content: 'How', confidence: 0.97, language: 'en' }],
    },
    {
      type: 'word',
      start_time: 1.4,
      end_time: 1.6,
      alternatives: [{ content: 'are', confidence: 0.97, language: 'en' }],
    },
    {
      type: 'word',
      start_time: 1.6,
      end_time: 1.9,
      alternatives: [{ content: 'you', confidence: 0.97, language: 'en' }],
    },
    {
      type: 'punctuation',
      start_time: 1.9,
      end_time: 1.9,
      attaches_to: 'previous',
      is_eos: true,
      alternatives: [{ content: '?', confidence: 1, language: 'en' }],
    },
  ],
};

const runningJob = { job: { id: 'job-1', status: 'running' } };
const doneJob = { job: { id: 'job-1', status: 'done', duration: 3.2 } };

type RecordedCall = {
  url: URL;
  method: string;
  headers: Headers;
  body: BodyInit | null | undefined;
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function createMockFetch({
  jobStatuses = [runningJob, doneJob],
  createResponse = () => jsonResponse({ id: 'job-1' }, 201),
  transcriptBody = transcript as unknown,
}: {
  jobStatuses?: unknown[];
  createResponse?: () => Response;
  transcriptBody?: unknown;
} = {}) {
  const calls: RecordedCall[] = [];
  let polls = 0;

  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const method = init?.method ?? 'GET';
    calls.push({
      url,
      method,
      headers: new Headers(init?.headers as HeadersInit),
      body: init?.body,
    });

    if (method === 'POST' && url.pathname === '/v2/jobs') {
      return createResponse();
    }
    if (url.pathname === '/v2/jobs/job-1/transcript') {
      return jsonResponse(transcriptBody);
    }
    if (url.pathname === '/v2/jobs/job-1') {
      return jsonResponse(jobStatuses[Math.min(polls++, jobStatuses.length - 1)]);
    }
    return jsonResponse({ code: 404, error: 'Job not found' }, 404);
  });

  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const fastPolling = { speechmatics: { pollingIntervalMs: 1 } };

function configOf(call: RecordedCall) {
  return JSON.parse((call.body as FormData).get('config') as string);
}

describe('SpeechmaticsTranscriptionModel.doGenerate', () => {
  it('submits a job, polls until done and builds the transcript', async () => {
    const { fetch, calls } = createMockFetch();
    const model = createSpeechmatics({ apiKey: 'test-key', fetch }).transcription(
      'enhanced',
    );

    const result = await model.doGenerate({
      audio: new Uint8Array([1, 2, 3]),
      mediaType: 'audio/wav',
      providerOptions: fastPolling,
    });

    expect(result.text).toBe('Hello, world. How are you?');
    expect(result.segments).toEqual([
      { text: 'Hello, world.', startSecond: 0, endSecond: 0.9 },
      { text: 'How are you?', startSecond: 1.2, endSecond: 1.9 },
    ]);
    expect(result.words).toHaveLength(5);
    expect(result.language).toBe('en');
    expect(result.durationInSeconds).toBe(3.2);
    expect(result.usage).toEqual({ seconds: 3.2 });
    expect(result.providerMetadata).toEqual({
      speechmatics: { jobId: 'job-1' },
    });
    expect(result.response.modelId).toBe('enhanced');

    // create job, two polls, fetch transcript
    expect(calls.map(c => `${c.method} ${c.url.pathname}`)).toEqual([
      'POST /v2/jobs',
      'GET /v2/jobs/job-1',
      'GET /v2/jobs/job-1',
      'GET /v2/jobs/job-1/transcript',
    ]);
    expect(calls[0].url.origin).toBe('https://asr.api.speechmatics.com');
    expect(calls[3].url.searchParams.get('format')).toBe('json-v2');
    for (const call of calls) {
      expect(call.headers.get('authorization')).toBe('Bearer test-key');
    }

    expect(configOf(calls[0])).toEqual({
      type: 'transcription',
      transcription_config: { language: 'en', model: 'enhanced' },
    });
    expect((calls[0].body as FormData).get('data_file')).toBeInstanceOf(Blob);
  });

  it('accepts base64 audio', async () => {
    const { fetch, calls } = createMockFetch();
    const model = createSpeechmatics({ apiKey: 'k', fetch }).transcription();

    await model.doGenerate({
      audio: 'AQID', // bytes 1, 2, 3
      mediaType: 'audio/mpeg',
      providerOptions: fastPolling,
    });

    const file = (calls[0].body as FormData).get('data_file') as File;
    expect((await file.arrayBuffer()).byteLength).toBe(3);
    expect(file.name).toBe('audio.mp3');
  });

  it('maps provider options onto the job config', async () => {
    const { fetch, calls } = createMockFetch();
    const model = createSpeechmatics({ apiKey: 'k', fetch }).transcription(
      'standard',
    );

    await model.doGenerate({
      audio: new Uint8Array([1]),
      mediaType: 'audio/wav',
      providerOptions: {
        speechmatics: {
          pollingIntervalMs: 1,
          language: 'es',
          domain: 'finance',
          outputLocale: 'es-ES',
          diarization: 'speaker',
          enableEntities: true,
          additionalVocab: [
            { content: 'Speechmatics', soundsLike: ['speech matics'] },
            { content: 'Melia' },
          ],
        },
      },
    });

    expect(configOf(calls[0]).transcription_config).toEqual({
      language: 'es',
      model: 'standard',
      domain: 'finance',
      output_locale: 'es-ES',
      diarization: 'speaker',
      enable_entities: true,
      additional_vocab: [
        { content: 'Speechmatics', sounds_like: ['speech matics'] },
        { content: 'Melia' },
      ],
    });
  });

  it('uses a custom base URL without a trailing slash', async () => {
    const { fetch, calls } = createMockFetch();
    const model = createSpeechmatics({
      apiKey: 'k',
      baseURL: 'https://eu1.asr.api.speechmatics.com/',
      fetch,
    }).transcription();

    await model.doGenerate({
      audio: new Uint8Array([1]),
      mediaType: 'audio/wav',
      providerOptions: fastPolling,
    });

    expect(calls[0].url.href).toMatch(
      /^https:\/\/eu1\.asr\.api\.speechmatics\.com\/v2\/jobs/,
    );
  });

  it('throws when the job is rejected', async () => {
    const { fetch } = createMockFetch({
      jobStatuses: [
        {
          job: {
            id: 'job-1',
            status: 'rejected',
            errors: [{ message: 'unsupported audio' }],
          },
        },
      ],
    });
    const model = createSpeechmatics({ apiKey: 'k', fetch }).transcription();

    const error = await Promise.resolve(
      model.doGenerate({
        audio: new Uint8Array([1]),
        mediaType: 'audio/wav',
        providerOptions: fastPolling,
      }),
    ).catch((e: any) => e);

    expect(APICallError.isInstance(error)).toBe(true);
    expect(error.message).toBe(
      'Speechmatics job job-1 rejected: unsupported audio',
    );
    expect(error.isRetryable).toBe(false);
  });

  it('maps API errors from job creation', async () => {
    const { fetch } = createMockFetch({
      createResponse: () =>
        jsonResponse(
          { code: 401, error: 'Permission Denied', detail: 'invalid key' },
          401,
        ),
    });
    const model = createSpeechmatics({ apiKey: 'bad', fetch }).transcription();

    const error = await Promise.resolve(
      model.doGenerate({ audio: new Uint8Array([1]), mediaType: 'audio/wav' }),
    ).catch((e: any) => e);

    expect(APICallError.isInstance(error)).toBe(true);
    expect(error.statusCode).toBe(401);
    expect(error.message).toBe('Permission Denied: invalid key');
  });

  it('times out when the job does not finish', async () => {
    const { fetch } = createMockFetch({ jobStatuses: [runningJob] });
    const model = createSpeechmatics({ apiKey: 'k', fetch }).transcription();

    await expect(
      model.doGenerate({
        audio: new Uint8Array([1]),
        mediaType: 'audio/wav',
        providerOptions: {
          speechmatics: { pollingIntervalMs: 10, timeoutMs: 5 },
        },
      }),
    ).rejects.toThrow('did not finish within 5ms');
  });

  it('does not start work when already aborted', async () => {
    const { fetch, calls } = createMockFetch();
    const model = createSpeechmatics({ apiKey: 'k', fetch }).transcription();

    await expect(
      model.doGenerate({
        audio: new Uint8Array([1]),
        mediaType: 'audio/wav',
        abortSignal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

const labelled = (
  content: string,
  start: number,
  end: number,
  speaker: string,
) => ({
  type: 'word',
  start_time: start,
  end_time: end,
  alternatives: [{ content, confidence: 1, speaker }],
});

const diarizedTranscript = {
  metadata: { transcription_config: { language: 'en' } },
  results: [
    labelled('Hi', 0, 0.3, 'S1'),
    labelled('there', 0.3, 0.6, 'S1'),
    labelled('Hello', 1, 1.4, 'S2'),
    {
      type: 'entity',
      entity_class: 'cardinal',
      start_time: 1,
      end_time: 1.4,
      alternatives: [{ content: '25' }],
    },
  ],
};

describe('SpeechmaticsTranscriptionModel result extras', () => {
  it('returns speaker turns and entities in provider metadata', async () => {
    const { fetch } = createMockFetch({ transcriptBody: diarizedTranscript });
    const model = createSpeechmatics({ apiKey: 'k', fetch }).transcription();

    const result = await model.doGenerate({
      audio: new Uint8Array([1]),
      mediaType: 'audio/wav',
      providerOptions: {
        speechmatics: {
          pollingIntervalMs: 1,
          diarization: 'speaker',
          enableEntities: true,
        },
      },
    });

    expect(result.providerMetadata).toEqual({
      speechmatics: {
        jobId: 'job-1',
        utterances: [
          { speaker: 'S1', text: 'Hi there', startSecond: 0, endSecond: 0.6 },
          { speaker: 'S2', text: 'Hello', startSecond: 1, endSecond: 1.4 },
        ],
        entities: [
          { entityClass: 'cardinal', text: '25', startSecond: 1, endSecond: 1.4 },
        ],
      },
    });
    expect(result.text).toBe('Hi there Hello');
  });

  it('leaves speaker labels out when diarization was not requested', async () => {
    const { fetch } = createMockFetch({ transcriptBody: diarizedTranscript });
    const model = createSpeechmatics({ apiKey: 'k', fetch }).transcription();

    const result = await model.doGenerate({
      audio: new Uint8Array([1]),
      mediaType: 'audio/wav',
      providerOptions: fastPolling,
    });

    expect(result.providerMetadata?.speechmatics).not.toHaveProperty(
      'utterances',
    );
  });
});

describe('SpeechmaticsTranscriptionModel models and warnings', () => {
  const call = async (
    modelId: string,
    speechmaticsOptions: Record<string, unknown> = {},
  ) => {
    const { fetch, calls } = createMockFetch();
    const model = createSpeechmatics({ apiKey: 'k', fetch }).transcription(
      modelId,
    );
    const result = await model.doGenerate({
      audio: new Uint8Array([1]),
      mediaType: 'audio/wav',
      providerOptions: {
        speechmatics: { pollingIntervalMs: 1, ...speechmaticsOptions },
      },
    });
    return { result, config: configOf(calls[0]) };
  };

  it('has no warnings for an ordinary request', async () => {
    const { result } = await call('enhanced');
    expect(result.warnings).toEqual([]);
  });

  it('defaults to language multi for melia-1 and oak-1', async () => {
    for (const modelId of ['melia-1', 'oak-1']) {
      const { config } = await call(modelId);
      expect(config.transcription_config).toEqual({
        language: 'multi',
        model: modelId,
      });
    }
  });

  it('lets an explicit language override the multilingual default', async () => {
    const { config } = await call('melia-1', { language: 'es' });
    expect(config.transcription_config.language).toBe('es');
  });

  it('warns about custom vocabulary on multilingual models but still sends it', async () => {
    const { result, config } = await call('oak-1', {
      additionalVocab: [{ content: 'Speechmatics' }],
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      type: 'unsupported',
      feature: 'providerOptions.speechmatics.additionalVocab',
    });
    expect(config.transcription_config.additional_vocab).toEqual([
      { content: 'Speechmatics' },
    ]);
  });

  it('warns about entities on multilingual models only', async () => {
    const melia = await call('melia-1', { enableEntities: true });
    expect(melia.result.warnings).toHaveLength(1);
    expect(melia.result.warnings[0]).toMatchObject({ type: 'other' });

    const enhanced = await call('enhanced', { enableEntities: true });
    expect(enhanced.result.warnings).toEqual([]);
  });

  it('warns when the polling interval cannot fit inside the timeout', async () => {
    const { result } = await call('enhanced', {
      pollingIntervalMs: 10,
      timeoutMs: 10,
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ type: 'other' });
  });
});

describe('SpeechmaticsTranscriptionModel.doGenerateFromUrl', () => {
  it('asks Speechmatics to fetch http(s) URLs', async () => {
    const { fetch, calls } = createMockFetch();
    const model = createSpeechmatics({ apiKey: 'k', fetch }).transcription();

    const result = await model.doGenerateFromUrl!({
      audio: new URL('https://example.com/audio.mp3'),
      providerOptions: fastPolling,
    });

    expect(result?.text).toBe('Hello, world. How are you?');
    expect(configOf(calls[0]).fetch_data).toEqual({
      url: 'https://example.com/audio.mp3',
    });
    expect((calls[0].body as FormData).get('data_file')).toBeNull();
  });

  it('returns undefined for URLs Speechmatics cannot fetch', async () => {
    const { fetch, calls } = createMockFetch();
    const model = createSpeechmatics({ apiKey: 'k', fetch }).transcription();

    const result = await model.doGenerateFromUrl!({
      audio: new URL('data:audio/wav;base64,AAAA'),
    });

    expect(result).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
