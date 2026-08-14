// Streaming chat helpers: SSE frame splitting (chunk boundaries, CRLF,
// heartbeats, multi-line data), payload parsing (delta content / reasoning /
// usage / [DONE]) and the stream-endpoint mapping for both access modes.

import { describe, expect, it } from 'vitest';
import {
  chatStreamEndpoint,
  createSseDataCollector,
  parseChatStreamData,
} from './chatStream';

describe('parseChatStreamData', () => {
  it('parses a content delta', () => {
    expect(
      parseChatStreamData(
        JSON.stringify({ choices: [{ delta: { content: '你好' } }] }),
      ),
    ).toEqual({ content: '你好', reasoning: '', usage: null, model: null, done: false });
  });

  it('parses a reasoning delta and the chunk model id', () => {
    expect(
      parseChatStreamData(
        JSON.stringify({
          model: 'deepseek-v4-flash',
          choices: [{ delta: { reasoning_content: '用户在问…' } }],
        }),
      ),
    ).toEqual({
      content: '',
      reasoning: '用户在问…',
      usage: null,
      model: 'deepseek-v4-flash',
      done: false,
    });
  });

  it('parses the terminal usage chunk', () => {
    expect(
      parseChatStreamData(
        JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 34 } }),
      ),
    ).toEqual({
      content: '',
      reasoning: '',
      usage: { promptTokens: 120, completionTokens: 34 },
      model: null,
      done: false,
    });
  });

  it('flags [DONE] and ignores malformed or empty payloads', () => {
    expect(parseChatStreamData('[DONE]')?.done).toBe(true);
    expect(parseChatStreamData('not json')).toBeNull();
    expect(parseChatStreamData('')).toBeNull();
    expect(parseChatStreamData('   ')).toBeNull();
    expect(parseChatStreamData('42')).toBeNull();
  });

  it('degrades non-string delta fields to empty strings', () => {
    expect(
      parseChatStreamData(JSON.stringify({ choices: [{ delta: { content: null } }] })),
    ).toEqual({ content: '', reasoning: '', usage: null, model: null, done: false });
  });
});

describe('createSseDataCollector', () => {
  const collect = (chunks: string[]): string[] => {
    const events: string[] = [];
    const feed = createSseDataCollector((data) => events.push(data));
    for (const chunk of chunks) feed(chunk);
    return events;
  };

  it('emits complete events across arbitrary chunk splits', () => {
    expect(
      collect(['data: {"a":1}\n\nda', 'ta: {"b":2}\n', '\ndata: [D', 'ONE]\n\n']),
    ).toEqual(['{"a":1}', '{"b":2}', '[DONE]']);
  });

  it('skips heartbeat comments and non-data fields', () => {
    expect(collect([': keep-alive\nevent: message\nid: 7\ndata: hi\n\n'])).toEqual(['hi']);
  });

  it('joins multi-line data frames per the SSE spec', () => {
    expect(collect(['data: line1\ndata: line2\n\n'])).toEqual(['line1\nline2']);
  });

  it('tolerates CRLF framing', () => {
    expect(collect(['data: a\r\n\r\ndata: b\r\n\r\n'])).toEqual(['a', 'b']);
  });
});

describe('chatStreamEndpoint', () => {
  it('maps the demo gateway /api base onto the OpenAI-compatible /v1 surface', () => {
    expect(chatStreamEndpoint('demo_proxy', 'https://vesti.world/gate/api')).toBe(
      'https://vesti.world/gate/v1/chat/completions',
    );
  });

  it('passes through a demo base that is not /api-suffixed', () => {
    expect(chatStreamEndpoint('demo_proxy', 'https://vesti.world/gate/v1/')).toBe(
      'https://vesti.world/gate/v1/chat/completions',
    );
  });

  it('appends the standard path for BYOK bases', () => {
    expect(chatStreamEndpoint('custom_byok', 'https://api.deepseek.com/v1/')).toBe(
      'https://api.deepseek.com/v1/chat/completions',
    );
  });
});
