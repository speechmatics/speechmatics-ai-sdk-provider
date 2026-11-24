import { NoSuchModelError } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { createSpeechmatics } from './speechmatics-provider';

describe('createSpeechmatics', () => {
  const provider = createSpeechmatics({ apiKey: 'test-key' });

  it('creates transcription models with the enhanced model by default', () => {
    const model = provider.transcription();

    expect(model.specificationVersion).toBe('v4');
    expect(model.provider).toBe('speechmatics.transcription');
    expect(model.modelId).toBe('enhanced');
  });

  it('passes through the requested model id', () => {
    expect(provider.transcriptionModel!('standard').modelId).toBe('standard');
  });

  it('accepts the three batch models and linden-1', () => {
    for (const modelId of [
      'enhanced',
      'standard',
      'melia-1',
      'linden-1',
    ] as const) {
      expect(provider.transcription(modelId).modelId).toBe(modelId);
    }
  });

  it('rejects models that are not offered, including oak-1 and linden-2', () => {
    for (const modelId of ['oak-1', 'linden-2', 'nonsense']) {
      expect(() => provider.transcription(modelId as 'enhanced')).toThrow(
        NoSuchModelError,
      );
    }
  });

  it('rejects model types Speechmatics does not provide', () => {
    expect(() => provider.languageModel('x')).toThrow(NoSuchModelError);
    expect(() => provider.embeddingModel('x')).toThrow(NoSuchModelError);
    expect(() => provider.imageModel('x')).toThrow(NoSuchModelError);
  });
});
