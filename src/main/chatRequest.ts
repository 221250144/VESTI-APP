export interface ChatCompletionRequestSettings {
  modelId: string;
  temperature: number;
  maxTokens: number;
}

export interface ChatCompletionMessage {
  role: string;
  content: string;
}

/** Build an OpenAI-compatible chat body. Zero means no max_tokens key at all. */
export function buildChatCompletionBody(
  settings: ChatCompletionRequestSettings,
  messages: ChatCompletionMessage[],
): string {
  return JSON.stringify({
    model: settings.modelId,
    messages,
    temperature: settings.temperature,
    ...(settings.maxTokens > 0 ? { max_tokens: settings.maxTokens } : {}),
    stream: false,
  });
}
