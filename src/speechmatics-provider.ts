import {
  NoSuchModelError,
  type ProviderV4,
  type TranscriptionModelV4,
} from '@ai-sdk/provider';
import {
  loadApiKey,
  resolveWith,
  withUserAgentSuffix,
  type FetchFunction,
  type Resolvable,
} from '@ai-sdk/provider-utils';
import { SpeechmaticsTranscriptionModel } from './speechmatics-transcription-model';
import {
  SPEECHMATICS_BATCH_MODEL_IDS,
  type SpeechmaticsTranscriptionModelId,
} from './speechmatics-transcription-options';
import { VERSION } from './version';

const DEFAULT_BASE_URL = 'https://asr.api.speechmatics.com';

export interface SpeechmaticsProvider extends ProviderV4 {
  /**
   * Creates a model for transcription. Defaults to the `enhanced` model.
   */
  transcription(
    modelId?: SpeechmaticsTranscriptionModelId,
  ): TranscriptionModelV4;

  /**
   * @deprecated Use `embeddingModel` instead.
   */
  textEmbeddingModel(modelId: string): never;
}

export interface SpeechmaticsProviderSettings {
  /**
   * API key for authenticating requests. May be a string, promise, or a
   * synchronous/asynchronous callback called before each request. Defaults to
   * the `SPEECHMATICS_API_KEY` environment variable.
   */
  apiKey?: Resolvable<string>;

  /**
   * Base URL of the Speechmatics batch API. Defaults to
   * `https://asr.api.speechmatics.com`. Use this to select a region or point at
   * a self-hosted deployment.
   */
  baseURL?: string;

  /**
   * Custom headers to include in the requests.
   */
  headers?: Record<string, string>;

  /**
   * Custom fetch implementation. You can use it as a middleware to intercept requests,
   * or to provide a custom fetch implementation for e.g. testing.
   */
  fetch?: FetchFunction;
}

/**
 * Create a Speechmatics provider instance.
 */
export function createSpeechmatics(
  options: SpeechmaticsProviderSettings = {},
): SpeechmaticsProvider {
  const baseURL = (options.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');

  const getHeaders = () =>
    resolveWith(options.apiKey, apiKey =>
      withUserAgentSuffix(
        {
          authorization: `Bearer ${loadApiKey({
            apiKey,
            environmentVariableName: 'SPEECHMATICS_API_KEY',
            description: 'Speechmatics',
          })}`,
          ...options.headers,
        },
        `ai-sdk-speechmatics/${VERSION}`,
      ),
    );

  const createTranscriptionModel = (
    modelId: SpeechmaticsTranscriptionModelId = 'enhanced',
  ) => {
    // The type already restricts this, but callers without type checking can
    // pass anything.
    if (!(SPEECHMATICS_BATCH_MODEL_IDS as readonly string[]).includes(modelId)) {
      throw new NoSuchModelError({
        modelId,
        modelType: 'transcriptionModel',
        message: `Speechmatics batch transcription supports these models: ${SPEECHMATICS_BATCH_MODEL_IDS.join(', ')}. Got "${modelId}".`,
      });
    }

    return new SpeechmaticsTranscriptionModel(modelId, {
      provider: 'speechmatics.transcription',
      url: ({ path }) => `${baseURL}${path}`,
      headers: getHeaders,
      fetch: options.fetch,
    });
  };

  const provider = {
    specificationVersion: 'v4' as const,
    transcription: createTranscriptionModel,
    transcriptionModel: createTranscriptionModel,

    // Required ProviderV4 methods that are not supported
    languageModel: (modelId: string) => {
      throw new NoSuchModelError({
        modelId,
        modelType: 'languageModel',
        message: 'Speechmatics does not provide language models',
      });
    },
    embeddingModel: (modelId: string) => {
      throw new NoSuchModelError({
        modelId,
        modelType: 'embeddingModel',
        message: 'Speechmatics does not provide text embedding models',
      });
    },
    textEmbeddingModel: (modelId: string): never => {
      throw new NoSuchModelError({
        modelId,
        modelType: 'embeddingModel',
        message: 'Speechmatics does not provide text embedding models',
      });
    },
    imageModel: (modelId: string) => {
      throw new NoSuchModelError({
        modelId,
        modelType: 'imageModel',
        message: 'Speechmatics does not provide image models',
      });
    },
  };

  return provider as SpeechmaticsProvider;
}

/**
 * Default Speechmatics provider instance.
 */
export const speechmatics = createSpeechmatics();
