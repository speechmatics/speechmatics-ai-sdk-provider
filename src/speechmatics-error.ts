import {
  createJsonErrorResponseHandler,
  lazySchema,
  zodSchema,
  type InferSchema,
} from '@ai-sdk/provider-utils';
import { z } from 'zod/v4';

// Error shape returned by the Speechmatics batch API, e.g.
// {"code":401,"error":"Permission Denied","detail":"..."}
export const speechmaticsErrorDataSchema = lazySchema(() =>
  zodSchema(
    z.object({
      code: z.number().optional(),
      error: z.string(),
      detail: z.string().optional(),
    }),
  ),
);

export type SpeechmaticsErrorData = InferSchema<
  typeof speechmaticsErrorDataSchema
>;

export const speechmaticsFailedResponseHandler = createJsonErrorResponseHandler(
  {
    errorSchema: speechmaticsErrorDataSchema,
    errorToMessage: data =>
      data.detail != null ? `${data.error}: ${data.detail}` : data.error,
  },
);
