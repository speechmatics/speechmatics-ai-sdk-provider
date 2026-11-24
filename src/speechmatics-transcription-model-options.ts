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
       * Streaming only. Send non-final results as `transcript-partial` parts.
       * Defaults to true.
       */
      enablePartials: z.boolean().optional(),

      /**
       * Streaming only, not on `linden-1`. Longest delay in seconds before a
       * final result, from 0.7 to 4. Lower is faster but less accurate.
       * Defaults to 4.
       */
      maxDelay: z.number().min(0.7).max(4).optional(),

      /**
       * Streaming only, `enhanced` and `standard` only. Seconds of silence,
       * from 0 to 2, after which an `EndOfUtterance` message is sent. 0 or
       * unset turns it off.
       */
      endOfUtteranceSilenceTrigger: z.number().min(0).max(2).optional(),

      /**
       * Batch only. How often to check whether the job has finished, in
       * milliseconds. Defaults to 5000.
       */
      pollingIntervalMs: z.number().int().positive().optional(),

      /**
       * Batch only. Time limit for the job to finish, in milliseconds. It covers the
       * initial wait and polling, but does not cut short the transcript
       * download of a finished job. Defaults to 15 minutes. When it runs out, a
       * running job is cancelled and an error is thrown.
       */
      timeoutMs: z.number().int().positive().optional(),
    }),
  ),
);

export type SpeechmaticsTranscriptionModelOptions = InferSchema<
  typeof speechmaticsTranscriptionModelOptionsSchema
>;
