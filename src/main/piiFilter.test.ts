// piiFilter: pattern-level hits/misses and session-level scanning. The
// patterns mirror the server-side re-check (deploy/vesti-gate/server.mjs), so
// these fixtures double as the shared contract for what counts as PII.

import { describe, expect, it } from 'vitest';
import type { ConversationExportBundle, VestiConversationRecord, VestiMessageRecord } from '../shared/contracts';
import { containsPii, sessionContainsPii } from './piiFilter';

function makeConversation(overrides: Partial<VestiConversationRecord> = {}): VestiConversationRecord {
  return {
    id: 1,
    uuid: 'uuid-1',
    platform: 'kimi-code',
    title: 'Refactor the parser',
    snippet: 'how do I refactor this parser',
    url: '',
    source_created_at: 1_000,
    first_captured_at: 1_000,
    last_captured_at: 2_000,
    created_at: 1_000,
    updated_at: 2_000,
    message_count: 1,
    turn_count: 1,
    is_archived: false,
    is_trash: false,
    tags: [],
    topic_id: null,
    is_starred: false,
    _source: 'local_terminal',
    _cli_id: 'session-1',
    _cli_platform: 'kimi-code',
    ...overrides,
  };
}

function makeMessage(text: string, overrides: Partial<VestiMessageRecord> = {}): VestiMessageRecord {
  return {
    id: 1,
    conversation_id: 1,
    role: 'user',
    content_text: text,
    content_ast: null,
    content_ast_version: null,
    degraded_nodes_count: 0,
    citations: [],
    attachments: [],
    artifacts: [],
    normalized_html_snapshot: null,
    created_at: 1_500,
    _source: 'local_terminal',
    ...overrides,
  };
}

function makeBundle(
  conversation: Partial<VestiConversationRecord> = {},
  messages: VestiMessageRecord[] = [makeMessage('plain coding question')],
): ConversationExportBundle {
  return { conversation: makeConversation(conversation), messages };
}

describe('containsPii', () => {
  it('returns null for empty or clean text', () => {
    expect(containsPii(null)).toBeNull();
    expect(containsPii(undefined)).toBeNull();
    expect(containsPii('')).toBeNull();
    expect(containsPii('refactor src/main.ts and run the tests')).toBeNull();
  });

  it('matches mainland China phone numbers only as standalone 11-digit runs', () => {
    expect(containsPii('我的手机号是 13812345678，打给我')).toBe('cn-phone');
    expect(containsPii('19800001111')).toBe('cn-phone');
    // 12x prefix is not a mobile prefix; embedded in longer digit runs either.
    expect(containsPii('order 12345678901 shipped')).toBeNull();
    expect(containsPii('id=138123456789')).toBeNull();
  });

  it('matches email addresses', () => {
    expect(containsPii('contact me at user.name+dev@example-company.com')).toBe('email');
    expect(containsPii('not an address: user@localhost')).toBeNull();
  });

  it('matches 18-char id card numbers', () => {
    expect(containsPii('身份证 11010519491231002X')).toBe('cn-id-card');
    expect(containsPii('110105194912310021')).toBe('cn-id-card');
    expect(containsPii('short id 1101051949')).toBeNull();
  });

  it('matches 16-19 digit bank card numbers', () => {
    expect(containsPii('卡号 6222021234567890')).toBe('bank-card');
    expect(containsPii('6222021234567890123')).toBe('bank-card');
    expect(containsPii('version 12345678901234')).toBeNull();
  });

  it('matches private key blocks', () => {
    expect(containsPii('-----BEGIN RSA PRIVATE KEY-----\nMII...')).toBe('private-key');
    expect(containsPii('-----BEGIN PUBLIC KEY-----')).toBeNull();
  });

  it('matches AWS access key ids', () => {
    expect(containsPii('aws key: AKIAIOSFODNN7EXAMPLE')).toBe('aws-access-key');
    expect(containsPii('AKIAshort')).toBeNull();
  });

  it('matches OpenAI-style secret keys with a boundary guard', () => {
    expect(containsPii('OPENAI_API_KEY=sk-abcdefghijklmnop1234')).toBe('openai-key');
    expect(containsPii('sk-tooshort9')).toBeNull();
    // Preceded by an alphanumeric character: part of a longer token, not a key.
    expect(containsPii('xxsk-abcdefghijklmnop1234')).toBeNull();
  });
});

describe('sessionContainsPii', () => {
  it('returns null for a clean session', () => {
    expect(sessionContainsPii(makeBundle())).toBeNull();
  });

  it('scans the conversation title and snippet', () => {
    expect(sessionContainsPii(makeBundle({ title: '帮我查手机 13812345678 的话费' }))).toBe('cn-phone');
    expect(sessionContainsPii(makeBundle({ snippet: 'mail it to a@b.co' }))).toBe('email');
  });

  it('scans message text, thinking, tool input and tool output', () => {
    expect(sessionContainsPii(makeBundle({}, [makeMessage('我的卡号 6222021234567890')]))).toBe('bank-card');
    expect(sessionContainsPii(makeBundle({}, [makeMessage('clean', { _thinking: 'key is sk-abcdefghijklmnop1234' })]))).toBe('openai-key');
    expect(sessionContainsPii(makeBundle({}, [makeMessage('clean', { _tool_input: '{"to":"a@b.co"}' })]))).toBe('email');
    expect(sessionContainsPii(makeBundle({}, [makeMessage('clean', { _tool_output: '-----BEGIN PRIVATE KEY-----' })]))).toBe('private-key');
  });

  it('flags a session when any single message hits', () => {
    const bundle = makeBundle({}, [
      makeMessage('first clean message'),
      makeMessage('call 13700001111 please'),
      makeMessage('third clean message'),
    ]);
    expect(sessionContainsPii(bundle)).toBe('cn-phone');
  });
});
