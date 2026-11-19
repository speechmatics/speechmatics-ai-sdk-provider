import { APICallError } from '@ai-sdk/provider';
import type { SharedV4Warning, TranscriptionModelV4 } from '@ai-sdk/provider';
import {
  combineHeaders,
  convertBase64ToUint8Array,
  createJsonResponseHandler,
  delay,
  getFromApi,
  lazySchema,
  parseProviderOptions,
  postFormDataToApi,
  resolve,
  safeValidateTypes,
  serializeModelOptions,
  WORKFLOW_DESERIALIZE,
  WORKFLOW_SERIALIZE,
  zodSchema,
} from '@ai-sdk/provider-utils';
import { z } from 'zod/v4';
import type {
  SpeechmaticsJobConfig,
  SpeechmaticsTranscriptionConfig,
} from './speechmatics-api-types';
import type { SpeechmaticsConfig } from './speechmatics-config';
import { speechmaticsFailedResponseHandler } from './speechmatics-error';
import { speechmaticsTranscriptionModelOptionsSchema } from './speechmatics-transcription-model-options';
import type { SpeechmaticsTranscriptionModelId } from './speechmatics-transcription-options';
import { buildTranscript } from './speechmatics-transcript';

const DEFAULT_LANGUAGE = 'en';
// Melia 1 detects the language itself and is selected with `language: 'multi'`.
const MULTILINGUAL_LANGUAGE = 'multi';
const MULTILINGUAL_MODEL = 'melia-1';
const DEFAULT_POLLING_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1_000;

// Job creation blocks for up to this long so short files finish in one request.
// Kept well under the server's connection timeout: if the connection drops
// before the response arrives we lose the job id and the job is orphaned.
const MAX_CREATE_WAIT_SECONDS = 30;
// Consecutive retryable errors (5xx, 429, network) tolerated while polling.
// Retrying `doGenerate` would create, and bill, a second job.
const MAX_TRANSIENT_POLL_ERRORS = 3;
// A finished job's transcript can lag behind its status by a moment.
const MAX_TRANSCRIPT_ATTEMPTS = 5;

const FAILED_JOB_STATUSES = new Set(['rejected', 'deleted', 'expired']);

const FILE_EXTENSIONS: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/webm': 'webm',
  'audio/amr': 'amr',
  'video/mp4': 'mp4',
};

interface SpeechmaticsTranscriptionModelConfig extends SpeechmaticsConfig {
  _internal?: {
    currentDate?: () => Date;
  };
}

type GenerateOptions = Parameters<TranscriptionModelV4['doGenerate']>[0];
type GenerateResult = Awaited<ReturnType<TranscriptionModelV4['doGenerate']>>;
type GenerateFromUrlOptions = Parameters<
  NonNullable<TranscriptionModelV4['doGenerateFromUrl']>
>[0];

export class SpeechmaticsTranscriptionModel implements TranscriptionModelV4 {
  readonly specificationVersion = 'v4';

  get provider(): string {
    return this.config.provider;
  }

  static [WORKFLOW_SERIALIZE](model: SpeechmaticsTranscriptionModel) {
    return serializeModelOptions({
      modelId: model.modelId,
      config: model.config,
    });
  }

  static [WORKFLOW_DESERIALIZE](options: {
    modelId: SpeechmaticsTranscriptionModelId;
    config: SpeechmaticsTranscriptionModelConfig;
  }) {
    return new SpeechmaticsTranscriptionModel(options.modelId, options.config);
  }

  constructor(
    readonly modelId: SpeechmaticsTranscriptionModelId,
    private readonly config: SpeechmaticsTranscriptionModelConfig,
  ) {}

  private async getArgs({
    providerOptions,
  }: Pick<GenerateOptions, 'providerOptions'>) {
    const warnings: SharedV4Warning[] = [];

    const options = await parseProviderOptions({
      provider: 'speechmatics',
      providerOptions,
      schema: speechmaticsTranscriptionModelOptionsSchema,
    });

    const multilingual = this.modelId === MULTILINGUAL_MODEL;

    const transcriptionConfig: SpeechmaticsTranscriptionConfig = {
      language:
        options?.language ??
        (multilingual ? MULTILINGUAL_LANGUAGE : DEFAULT_LANGUAGE),
      model: this.modelId,
    };

    if (options?.domain != null) {
      transcriptionConfig.domain = options.domain;
    }
    if (options?.outputLocale != null) {
      transcriptionConfig.output_locale = options.outputLocale;
    }
    if (options?.diarization != null) {
      transcriptionConfig.diarization = options.diarization;
    }
    if (options?.additionalVocab != null) {
      transcriptionConfig.additional_vocab = options.additionalVocab.map(
        entry => ({
          content: entry.content,
          ...(entry.soundsLike != null
            ? { sounds_like: entry.soundsLike }
            : {}),
        }),
      );
    }
    if (options?.enableEntities != null) {
      transcriptionConfig.enable_entities = options.enableEntities;
    }

    const pollingIntervalMs =
      options?.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Warn rather than change what the caller asked for.
    if (multilingual && options?.additionalVocab != null) {
      warnings.push({
        type: 'unsupported',
        feature: 'providerOptions.speechmatics.additionalVocab',
        details: `Speechmatics does not support custom vocabulary on ${this.modelId}. The job may be rejected or the vocabulary ignored.`,
      });
    }
    if (multilingual && options?.enableEntities === true) {
      warnings.push({
        type: 'other',
        message: `On ${this.modelId}, Speechmatics only accepts enable_entities together with Entity Detection (entities_config.detect_advanced_entities), which this provider does not set. The job may be rejected.`,
      });
    }
    if (pollingIntervalMs >= timeoutMs) {
      warnings.push({
        type: 'other',
        message: `pollingIntervalMs (${pollingIntervalMs}) is not smaller than timeoutMs (${timeoutMs}), so the job is abandoned after its first status check.`,
      });
    }

    return {
      transcriptionConfig,
      warnings,
      pollingIntervalMs,
      timeoutMs,
      includeSpeakers:
        options?.diarization === 'speaker' ||
        options?.diarization === 'channel',
    };
  }

  async doGenerate(options: GenerateOptions): Promise<GenerateResult> {
    const bytes =
      typeof options.audio === 'string'
        ? convertBase64ToUint8Array(options.audio)
        : options.audio;

    const formData = new FormData();
    formData.append(
      'data_file',
      new Blob([bytes as Uint8Array<ArrayBuffer>], { type: options.mediaType }),
      `audio.${FILE_EXTENSIONS[options.mediaType] ?? 'bin'}`,
    );

    return this.runJob(options, formData);
  }

  async doGenerateFromUrl(
    options: GenerateFromUrlOptions,
  ): Promise<GenerateResult | undefined> {
    // Speechmatics fetches http(s) URLs itself. Anything else (data: URLs and
    // so on) falls back to the SDK downloading the audio and calling doGenerate.
    if (
      options.audio.protocol !== 'http:' &&
      options.audio.protocol !== 'https:'
    ) {
      return undefined;
    }

    return this.runJob(options, new FormData(), options.audio.toString());
  }

  private async runJob(
    options: Pick<GenerateOptions, 'providerOptions' | 'abortSignal' | 'headers'>,
    formData: FormData,
    fetchUrl?: string,
  ): Promise<GenerateResult> {
    const currentDate = this.config._internal?.currentDate?.() ?? new Date();
    const {
      transcriptionConfig,
      warnings,
      pollingIntervalMs,
      timeoutMs,
      includeSpeakers,
    } = await this.getArgs(options);

    const jobConfig: SpeechmaticsJobConfig = {
      type: 'transcription',
      transcription_config: transcriptionConfig,
      ...(fetchUrl != null ? { fetch_data: { url: fetchUrl } } : {}),
    };
    const requestBody = JSON.stringify(jobConfig);
    formData.append('config', requestBody);

    const headers = combineHeaders(
      await resolve(this.config.headers),
      options.headers,
    );

    const createWaitSeconds = Math.max(
      1,
      Math.min(MAX_CREATE_WAIT_SECONDS, Math.floor(timeoutMs / 1_000)),
    );
    const {
      value: created,
      rawValue: createdRawValue,
      responseHeaders: createdResponseHeaders,
    } = await postFormDataToApi({
      url: this.config.url({
        path: `/v2/jobs?wait=${createWaitSeconds}&format=json-v2`,
      }),
      headers,
      formData,
      failedResponseHandler: speechmaticsFailedResponseHandler,
      successfulResponseHandler: createJsonResponseHandler(
        createJobResponseSchema,
      ),
      abortSignal: options.abortSignal,
      fetch: this.config.fetch,
    });

    // With `wait`, a job that finishes in time comes back with its transcript
    // embedded. That is best-effort, so anything unusable falls through to polling.
    let embedded: z.infer<typeof transcriptShape> | undefined;
    if (created.status === 'done' && created['json-v2'] != null) {
      const validated = await safeValidateTypes({
        value: created['json-v2'],
        schema: transcriptResponseSchema,
      });
      if (validated.success) {
        embedded = validated.value;
      }
    }

    let job: { duration?: number | null } | undefined;
    let transcript: z.infer<typeof transcriptShape>;
    let rawValue: unknown = createdRawValue;
    let responseHeaders = createdResponseHeaders;

    if (embedded != null) {
      transcript = embedded;
    } else {
      job = await this.waitForJob({
        id: created.id,
        headers,
        abortSignal: options.abortSignal,
        pollingIntervalMs,
        timeoutMs,
      });

      ({
        value: transcript,
        rawValue,
        responseHeaders,
      } = await this.fetchTranscript({
        id: created.id,
        headers,
        abortSignal: options.abortSignal,
        pollingIntervalMs,
      }));
    }

    const { text, segments, words, utterances, entities } = buildTranscript(
      transcript.results,
      transcript.metadata?.language_pack_info?.word_delimiter ?? ' ',
      { includeSpeakers },
    );

    const durationInSeconds =
      job?.duration ??
      transcript.job?.duration ??
      transcript.results.reduce(
        (latest, item) => Math.max(latest, item.end_time),
        0,
      );

    return {
      text,
      segments,
      ...(words.length > 0 ? { words } : {}),
      language:
        transcript.metadata?.transcription_config?.language ?? undefined,
      durationInSeconds,
      usage: { seconds: durationInSeconds },
      warnings,
      request: { body: requestBody },
      response: {
        timestamp: currentDate,
        modelId: this.modelId,
        headers: responseHeaders,
        body: rawValue,
      },
      // Speaker turns and entities have no place in the AI SDK result shape, so
      // they go here. All times are in seconds, like `segments`.
      providerMetadata: {
        speechmatics: {
          jobId: created.id,
          ...(utterances != null ? { utterances } : {}),
          ...(entities != null ? { entities } : {}),
        },
      },
    };
  }

  private async fetchTranscript({
    id,
    headers,
    abortSignal,
    pollingIntervalMs,
  }: {
    id: string;
    headers: Record<string, string | undefined>;
    abortSignal: AbortSignal | undefined;
    pollingIntervalMs: number;
  }) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await getFromApi({
          url: this.config.url({
            path: `/v2/jobs/${id}/transcript?format=json-v2&wait=0`,
          }),
          headers,
          failedResponseHandler: speechmaticsFailedResponseHandler,
          successfulResponseHandler: createJsonResponseHandler(
            transcriptResponseSchema,
          ),
          abortSignal,
          fetch: this.config.fetch,
          validateUrl: false,
        });
      } catch (error) {
        // 404 means the transcript is not ready yet.
        const retryable =
          isTransientError(error) ||
          (APICallError.isInstance(error) && error.statusCode === 404);
        if (!retryable || attempt >= MAX_TRANSCRIPT_ATTEMPTS) {
          throw error;
        }
        await delay(pollingIntervalMs, { abortSignal });
      }
    }
  }

  private async waitForJob({
    id,
    headers,
    abortSignal,
    pollingIntervalMs,
    timeoutMs,
  }: {
    id: string;
    headers: Record<string, string | undefined>;
    abortSignal: AbortSignal | undefined;
    pollingIntervalMs: number;
    timeoutMs: number;
  }) {
    // `wait=0` returns immediately. Without it the server applies a default
    // wait that is unspecified and will grow, which would skew the interval.
    const url = this.config.url({ path: `/v2/jobs/${id}?wait=0` });
    const deadline = Date.now() + timeoutMs;
    let transientErrors = 0;

    while (true) {
      let response;
      try {
        ({ value: response } = await getFromApi({
          url,
          headers,
          failedResponseHandler: speechmaticsFailedResponseHandler,
          successfulResponseHandler: createJsonResponseHandler(
            jobResponseSchema,
          ),
          abortSignal,
          fetch: this.config.fetch,
          validateUrl: false,
        }));
        transientErrors = 0;
      } catch (error) {
        if (
          !isTransientError(error) ||
          ++transientErrors > MAX_TRANSIENT_POLL_ERRORS ||
          Date.now() + pollingIntervalMs > deadline
        ) {
          throw error;
        }
        await delay(pollingIntervalMs, { abortSignal });
        continue;
      }
      const { job } = response;

      if (job.status === 'done') {
        return job;
      }

      if (FAILED_JOB_STATUSES.has(job.status)) {
        const details = (job.errors ?? [])
          .map(error => error.message)
          .filter((message): message is string => message != null)
          .join('; ');

        throw new APICallError({
          message: `Speechmatics job ${id} ${job.status}${
            details.length > 0 ? `: ${details}` : ''
          }`,
          url,
          requestBodyValues: {},
          isRetryable: false,
          data: response,
        });
      }

      if (Date.now() + pollingIntervalMs > deadline) {
        throw new APICallError({
          message: `Speechmatics job ${id} did not finish within ${timeoutMs}ms`,
          url,
          requestBodyValues: {},
          isRetryable: false,
        });
      }

      await delay(pollingIntervalMs, { abortSignal });
    }
  }
}

const createJobResponseSchema = lazySchema(() =>
  zodSchema(
    z.object({
      id: z.string(),
      // Only present when `wait` was passed. Not the job lifecycle status: it
      // reports whether the job finished within the wait.
      status: z.string().nullish(),
      // Validated separately so an unexpected shape cannot fail a job that has
      // already been created.
      'json-v2': z.unknown().nullish(),
    }),
  ),
);

const isTransientError = (error: unknown) =>
  APICallError.isInstance(error) && error.isRetryable;

const jobResponseSchema = lazySchema(() =>
  zodSchema(
    z.object({
      job: z.object({
        id: z.string(),
        status: z.string(),
        duration: z.number().nullish(),
        errors: z
          .array(
            z.object({
              message: z.string().nullish(),
            }),
          )
          .nullish(),
      }),
    }),
  ),
);

const transcriptShape = z.object({
  job: z
    .object({
      duration: z.number().nullish(),
    })
    .nullish(),
  metadata: z
    .object({
      transcription_config: z
        .object({
          language: z.string().nullish(),
        })
        .nullish(),
      language_pack_info: z
        .object({
          word_delimiter: z.string().nullish(),
        })
        .nullish(),
    })
    .nullish(),
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
            speaker: z.string().nullish(),
          }),
        )
        .nullish(),
    }),
  ),
});

const transcriptResponseSchema = lazySchema(() =>
  zodSchema(transcriptShape),
);
