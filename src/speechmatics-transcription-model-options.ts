import {
  lazySchema,
  zodSchema,
  type InferSchema,
} from '@ai-sdk/provider-utils';
import { z } from 'zod/v4';

// Passed under `providerOptions.speechmatics`.
export const speechmaticsTranscriptionModelOptionsSchema = lazySchema(() =>
  zodSchema(
    z.object({
      /**
       * Language of the audio as a Speechmatics language code, e.g. `en`.
       * Defaults to `en`, or `multi` for the `melia-1` model.
       */
      language: z.string().optional(),

      /**
       * Request a model specialised for a field, e.g. `finance` or `medical`.
       */
      domain: z.string().optional(),

      /**
       * Language locale for the transcript output, e.g. `en-GB`.
       */
      outputLocale: z.string().optional(),

      /**
       * Whether speaker or channel labels are added to the transcript. The
       * labelled turns are returned in `providerMetadata.speechmatics.utterances`.
       */
      diarization: z.enum(['none', 'speaker', 'channel']).optional(),

      /**
       * Custom words or phrases to recognise, with optional alternative pronunciations.
       */
      additionalVocab: z
        .array(
          z.object({
            content: z.string(),
            soundsLike: z.array(z.string()).optional(),
          }),
        )
        .optional(),

      /**
       * Include entity items (dates, numbers, ...) in the transcript. They are
       * returned in `providerMetadata.speechmatics.entities`.
       */
      enableEntities: z.boolean().optional(),

      /**
       * How often to check whether the job has finished, in milliseconds.
       * Defaults to 5000.
       */
      pollingIntervalMs: z.number().int().positive().optional(),

      /**
       * How long to wait for the job to finish, in milliseconds.
       * Defaults to 15 minutes.
       */
      timeoutMs: z.number().int().positive().optional(),
    }),
  ),
);

export type SpeechmaticsTranscriptionModelOptions = InferSchema<
  typeof speechmaticsTranscriptionModelOptionsSchema
>;
