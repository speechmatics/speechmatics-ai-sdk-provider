import { APICallError } from '@ai-sdk/provider';
import { describe, expect, it, vi } from 'vitest';
import { createSpeechmatics } from './speechmatics-provider';
import type { SpeechmaticsTranscriptionModelId } from './speechmatics-transcription-options';

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

// A job status is either a JSON body or a factory for a full response, so
// tests can return errors. The last entry repeats once the list is exhausted.
type Reply = unknown | (() => Response);

const reply = (entry: Reply) =>
  typeof entry === 'function' ? (entry as () => Response)() : jsonResponse(entry);

const errorResponse = (status: number) =>
  jsonResponse({ code: status, error: `status ${status}` }, status);

function createMockFetch({
  jobStatuses = [runningJob, doneJob],
  createResponse = () => jsonResponse({ id: 'job-1' }, 201),
  transcriptBody = transcript as unknown,
  transcriptReplies = [transcriptBody],
}: {
  jobStatuses?: Reply[];
  createResponse?: () => Response;
  transcriptBody?: unknown;
  transcriptReplies?: Reply[];
} = {}) {
  const calls: RecordedCall[] = [];
  let polls = 0;
  let transcriptFetches = 0;

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
      return reply(
        transcriptReplies[
          Math.min(transcriptFetches++, transcriptReplies.length - 1)
        ],
      );
    }
    if (url.pathname === '/v2/jobs/job-1') {
      return reply(jobStatuses[Math.min(polls++, jobStatuses.length - 1)]);
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
    modelId: SpeechmaticsTranscriptionModelId,
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

  it('defaults to language multi for melia-1 only', async () => {
    const melia = await call('melia-1');
    expect(melia.config.transcription_config).toEqual({
      language: 'multi',
      model: 'melia-1',
    });

    for (const modelId of ['enhanced', 'standard'] as const) {
      const { config } = await call(modelId);
      expect(config.transcription_config.language).toBe('en');
    }
  });

  it('lets an explicit language override the multilingual default', async () => {
    const { config } = await call('melia-1', { language: 'es' });
    expect(config.transcription_config.language).toBe('es');
  });

  it('warns about custom vocabulary on melia-1 but still sends it', async () => {
    const { result, config } = await call('melia-1', {
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

  it('warns about entities on melia-1 only', async () => {
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

const requests = (calls: RecordedCall[]) =>
  calls.map(c => `${c.method} ${c.url.pathname}`);

const generate = (
  fetch: typeof globalThis.fetch,
  speechmaticsOptions: Record<string, unknown> = {},
) =>
  Promise.resolve(
    createSpeechmatics({ apiKey: 'k', fetch })
      .transcription()
      .doGenerate({
        audio: new Uint8Array([1]),
        mediaType: 'audio/wav',
        providerOptions: {
          speechmatics: { pollingIntervalMs: 1, ...speechmaticsOptions },
        },
      }),
  );

describe('SpeechmaticsTranscriptionModel waiting and polling', () => {
  describe('job creation', () => {
    it('asks the server to wait and embed the transcript', async () => {
      const { fetch, calls } = createMockFetch();
      await generate(fetch);

      expect(calls[0].url.searchParams.get('wait')).toBe('30');
      expect(calls[0].url.searchParams.get('format')).toBe('json-v2');
    });

    it('never waits longer than the timeout', async () => {
      const { fetch, calls } = createMockFetch();
      await generate(fetch, { timeoutMs: 10_000 });
      expect(calls[0].url.searchParams.get('wait')).toBe('10');
    });

    it('waits at least one second, because wait=0 means no wait', async () => {
      const { fetch, calls } = createMockFetch();
      await generate(fetch, { timeoutMs: 500, pollingIntervalMs: 1 });
      expect(calls[0].url.searchParams.get('wait')).toBe('1');
    });

    it('uses the embedded transcript and makes no further requests', async () => {
      const { fetch, calls } = createMockFetch({
        createResponse: () =>
          jsonResponse(
            {
              id: 'job-1',
              status: 'done',
              'json-v2': { ...transcript, job: { duration: 4.5 } },
            },
            201,
          ),
      });

      const result = await generate(fetch);

      expect(requests(calls)).toEqual(['POST /v2/jobs']);
      expect(result.text).toBe('Hello, world. How are you?');
      expect(result.language).toBe('en');
      expect(result.durationInSeconds).toBe(4.5);
      expect(result.providerMetadata).toEqual({
        speechmatics: { jobId: 'job-1' },
      });
    });

    it('falls back to the last word end time without a job duration', async () => {
      const { fetch } = createMockFetch({
        createResponse: () =>
          jsonResponse(
            { id: 'job-1', status: 'done', 'json-v2': transcript },
            201,
          ),
      });

      const result = await generate(fetch);
      expect(result.durationInSeconds).toBe(1.9);
    });

    it('polls when the job is still running after the wait', async () => {
      const { fetch, calls } = createMockFetch({
        createResponse: () =>
          jsonResponse({ id: 'job-1', status: 'created' }, 201),
        jobStatuses: [doneJob],
      });

      const result = await generate(fetch);

      expect(requests(calls)).toEqual([
        'POST /v2/jobs',
        'GET /v2/jobs/job-1',
        'GET /v2/jobs/job-1/transcript',
      ]);
      expect(result.durationInSeconds).toBe(3.2);
    });

    it('fetches the transcript when done but nothing was embedded', async () => {
      const { fetch, calls } = createMockFetch({
        createResponse: () => jsonResponse({ id: 'job-1', status: 'done' }, 201),
        jobStatuses: [doneJob],
      });

      const result = await generate(fetch);

      expect(requests(calls)).toEqual([
        'POST /v2/jobs',
        'GET /v2/jobs/job-1',
        'GET /v2/jobs/job-1/transcript',
      ]);
      expect(result.text).toBe('Hello, world. How are you?');
    });

    it('ignores an embedded transcript it cannot read', async () => {
      const { fetch, calls } = createMockFetch({
        createResponse: () =>
          jsonResponse(
            { id: 'job-1', status: 'done', 'json-v2': { unexpected: true } },
            201,
          ),
        jobStatuses: [doneJob],
      });

      const result = await generate(fetch);

      expect(requests(calls)).toContain('GET /v2/jobs/job-1/transcript');
      expect(result.text).toBe('Hello, world. How are you?');
    });

    it('reports a job rejected during the wait with its errors', async () => {
      const { fetch } = createMockFetch({
        createResponse: () =>
          jsonResponse({ id: 'job-1', status: 'rejected' }, 201),
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

      await expect(generate(fetch)).rejects.toThrow(
        'Speechmatics job job-1 rejected: unsupported audio',
      );
    });

    it('polls without an embedded transcript when wait is unsupported', async () => {
      // On-prem ignores `wait`: the response is just the job id.
      const { fetch, calls } = createMockFetch();
      const result = await generate(fetch);

      expect(requests(calls)).toEqual([
        'POST /v2/jobs',
        'GET /v2/jobs/job-1',
        'GET /v2/jobs/job-1',
        'GET /v2/jobs/job-1/transcript',
      ]);
      expect(result.text).toBe('Hello, world. How are you?');
    });
  });

  describe('polling', () => {
    it('returns immediately from status and transcript requests', async () => {
      const { fetch, calls } = createMockFetch();
      await generate(fetch);

      // The server applies its own default wait unless told not to.
      for (const call of calls.slice(1)) {
        expect(call.url.searchParams.get('wait')).toBe('0');
      }
    });

    it('checks every 5 seconds by default', async () => {
      vi.useFakeTimers();
      try {
        const { fetch, calls } = createMockFetch({
          jobStatuses: [runningJob, runningJob, doneJob],
        });
        const promise = createSpeechmatics({ apiKey: 'k', fetch })
          .transcription()
          .doGenerate({ audio: new Uint8Array([1]), mediaType: 'audio/wav' });
        const polls = () =>
          calls.filter(c => c.url.pathname === '/v2/jobs/job-1').length;

        await vi.advanceTimersByTimeAsync(0);
        expect(polls()).toBe(1);
        await vi.advanceTimersByTimeAsync(4_999);
        expect(polls()).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(polls()).toBe(2);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(polls()).toBe(3);

        await expect(promise).resolves.toMatchObject({
          text: 'Hello, world. How are you?',
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps polling through transient errors', async () => {
      const { fetch, calls } = createMockFetch({
        jobStatuses: [() => errorResponse(503), () => errorResponse(429), doneJob],
      });

      const result = await generate(fetch);

      expect(requests(calls).filter(r => r === 'GET /v2/jobs/job-1')).toHaveLength(
        3,
      );
      expect(result.text).toBe('Hello, world. How are you?');
    });

    it('only counts consecutive transient errors', async () => {
      const failing = () => errorResponse(503);
      const { fetch } = createMockFetch({
        jobStatuses: [
          failing,
          failing,
          failing,
          runningJob,
          failing,
          failing,
          failing,
          doneJob,
        ],
      });

      await expect(generate(fetch)).resolves.toMatchObject({
        text: 'Hello, world. How are you?',
      });
    });

    it('gives up after repeated transient errors', async () => {
      const { fetch, calls } = createMockFetch({
        jobStatuses: [() => errorResponse(503)],
      });

      const error = await generate(fetch).catch((e: any) => e);

      expect(APICallError.isInstance(error)).toBe(true);
      expect(error.statusCode).toBe(503);
      // one attempt plus three tolerated retries
      expect(requests(calls).filter(r => r === 'GET /v2/jobs/job-1')).toHaveLength(
        4,
      );
    });

    it('does not retry errors that are not transient', async () => {
      const { fetch, calls } = createMockFetch({
        jobStatuses: [() => errorResponse(401)],
      });

      const error = await generate(fetch).catch((e: any) => e);

      expect(error.statusCode).toBe(401);
      expect(requests(calls).filter(r => r === 'GET /v2/jobs/job-1')).toHaveLength(
        1,
      );
    });

    it('retries a dropped connection while polling', async () => {
      let dropped = false;
      const { fetch: base } = createMockFetch({ jobStatuses: [doneJob] });
      const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          typeof input === 'string' ? input : (input as URL | Request).toString(),
        );
        if (url.pathname === '/v2/jobs/job-1' && !dropped) {
          dropped = true;
          throw Object.assign(new TypeError('fetch failed'), {
            cause: new Error('socket hang up'),
          });
        }
        return base(input, init);
      }) as unknown as typeof globalThis.fetch;

      await expect(generate(fetch)).resolves.toMatchObject({
        text: 'Hello, world. How are you?',
      });
      expect(dropped).toBe(true);
    });
  });

  describe('fetching the transcript', () => {
    it('retries while the transcript is not ready', async () => {
      const notReady = () =>
        jsonResponse({ code: 404, error: 'Transcription not ready' }, 404);
      const { fetch, calls } = createMockFetch({
        jobStatuses: [doneJob],
        transcriptReplies: [notReady, notReady, transcript],
      });

      const result = await generate(fetch);

      expect(
        requests(calls).filter(r => r === 'GET /v2/jobs/job-1/transcript'),
      ).toHaveLength(3);
      expect(result.text).toBe('Hello, world. How are you?');
    });

    it('gives up if the transcript never becomes ready', async () => {
      const { fetch, calls } = createMockFetch({
        jobStatuses: [doneJob],
        transcriptReplies: [
          () => jsonResponse({ code: 404, error: 'Transcription not ready' }, 404),
        ],
      });

      const error = await generate(fetch).catch((e: any) => e);

      expect(error.statusCode).toBe(404);
      expect(
        requests(calls).filter(r => r === 'GET /v2/jobs/job-1/transcript'),
      ).toHaveLength(5);
    });

    it('does not retry other errors', async () => {
      const { fetch, calls } = createMockFetch({
        jobStatuses: [doneJob],
        transcriptReplies: [() => errorResponse(401)],
      });

      const error = await generate(fetch).catch((e: any) => e);

      expect(error.statusCode).toBe(401);
      expect(
        requests(calls).filter(r => r === 'GET /v2/jobs/job-1/transcript'),
      ).toHaveLength(1);
    });
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
