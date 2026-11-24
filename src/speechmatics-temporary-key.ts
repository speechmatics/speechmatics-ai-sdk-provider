import {
  createJsonResponseHandler,
  lazySchema,
  loadApiKey,
  postJsonToApi,
  withUserAgentSuffix,
  zodSchema,
  type FetchFunction,
} from '@ai-sdk/provider-utils';
import { z } from 'zod/v4';
import { speechmaticsFailedResponseHandler } from './speechmatics-error';
import { VERSION } from './version';

// Temporary keys of type `rt` work for both the Realtime and Agent STT APIs, in
// every region.
const TEMPORARY_KEY_URL = 'https://mp.speechmatics.com/v1/jwts?type=rt';
const DEFAULT_TTL_SECONDS = 60;

const temporaryKeyResponseSchema = lazySchema(() =>
  zodSchema(z.object({ key_value: z.string() })),
);

/**
 * Exchanges an API key for a temporary key. Used by the provider before each
 * streaming session, so the API key itself is never sent over the WebSocket.
 */
export async function requestTemporaryKey({
  headers,
  ttl = DEFAULT_TTL_SECONDS,
  fetch,
  abortSignal,
}: {
  headers: Record<string, string | undefined>;
  ttl?: number;
  fetch?: FetchFunction;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const { value } = await postJsonToApi({
    url: TEMPORARY_KEY_URL,
    headers,
    body: { ttl },
    failedResponseHandler: speechmaticsFailedResponseHandler,
    successfulResponseHandler: createJsonResponseHandler(
      temporaryKeyResponseSchema,
    ),
    abortSignal,
    fetch,
  });
  return value.key_value;
}

/**
 * Creates a short-lived key for streaming transcription. Call it on your server
 * and hand the key to the browser, which passes it back through the provider's
 * `getTemporaryKey` setting. The key can start any number of sessions until it
 * expires, and it cannot be used for batch transcription.
 */
export async function createTemporaryKey({
  apiKey,
  ttl = DEFAULT_TTL_SECONDS,
  fetch,
  abortSignal,
}: {
  /**
   * API key to exchange. Defaults to the `SPEECHMATICS_API_KEY` environment
   * variable.
   */
  apiKey?: string;
  /**
   * Lifetime of the key in seconds, from 60 to 86400. Defaults to 60. Keep it as
   * short as you can: it only needs to last until the session starts.
   */
  ttl?: number;
  fetch?: FetchFunction;
  abortSignal?: AbortSignal;
} = {}): Promise<string> {
  return requestTemporaryKey({
    headers: withUserAgentSuffix(
      {
        authorization: `Bearer ${loadApiKey({
          apiKey,
          environmentVariableName: 'SPEECHMATICS_API_KEY',
          description: 'Speechmatics',
        })}`,
      },
      `ai-sdk-speechmatics/${VERSION}`,
    ),
    ttl,
    fetch,
    abortSignal,
  });
}
