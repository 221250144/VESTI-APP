import { describe, expect, it } from 'vitest';
import { buildChatCompletionBody } from './chatRequest';

const messages = [{ role: 'user', content: 'hello' }];

describe('buildChatCompletionBody', () => {
  it('omits max_tokens entirely in Auto mode and passes through the model', () => {
    const body = JSON.parse(buildChatCompletionBody({
      modelId: 'provider/new-model',
      temperature: 0.3,
      maxTokens: 0,
    }, messages));

    expect(body).toMatchObject({ model: 'provider/new-model', stream: false });
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('keeps an explicit positive output limit', () => {
    const body = JSON.parse(buildChatCompletionBody({
      modelId: 'custom-model',
      temperature: 0.7,
      maxTokens: 32_768,
    }, messages));

    expect(body.max_tokens).toBe(32_768);
  });
});
