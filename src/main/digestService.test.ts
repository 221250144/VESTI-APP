import { describe, expect, it, vi } from 'vitest';
import type { SessionDigest } from '@vesti/capture-core';
import type { SessionDetail, SessionMessage } from '../shared/contracts';
import {
  DIGEST_VERSION,
  DigestService,
  buildDigestTranscript,
  type DigestAgentRunner,
  type DigestEmbedder,
  type DigestSessionStore,
} from './digestService';

function makeMessage(overrides: Partial<SessionMessage>): SessionMessage {
  return {
    id: 'm1',
    sessionId: 'codex:s1',
    source: 'user_input',
    role: 'user',
    contentText: '帮我实现登录功能',
    timestamp: 1000,
    ...overrides,
  };
}

function makeDetail(id: string, messages: SessionMessage[]): SessionDetail {
  return {
    session: {
      id,
      sessionId: id.split(':')[1] ?? id,
      platform: 'codex',
      projectPath: 'C:\\work\\alpha',
      title: 'Session',
      status: 'active',
      startedAt: 1000,
      lastActivityAt: 2000,
      messageCount: messages.length,
      turnCount: 0,
      toolCallCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    },
    messages,
  };
}

class FakeStore implements DigestSessionStore {
  details = new Map<string, SessionDetail>();
  digests = new Map<string, SessionDigest>();
  needing: Array<{ id: string; messageCount: number }> = [];

  getSession(id: string): SessionDetail | null {
    return this.details.get(id) ?? null;
  }
  listSessionsNeedingDigest(): Array<{ id: string; messageCount: number }> {
    return this.needing;
  }
  upsertSessionDigest(digest: SessionDigest): void {
    this.digests.set(digest.sessionId, digest);
  }
}

const GOOD_PAYLOAD = {
  one_liner: '实现登录功能并接入 JWT',
  key_topics: ['认证', 'JWT'],
  key_files: ['src/Login.tsx'],
  decisions: ['使用 JWT'],
  open_questions: ['刷新令牌策略未定'],
};

function makeAgent(run: DigestAgentRunner['run']): DigestAgentRunner {
  return { run: vi.fn(run) };
}

function makeEmbedding(embed?: DigestEmbedder['embed']): DigestEmbedder {
  return { embed: vi.fn(embed ?? (async (texts: string[]) => texts.map(() => new Float32Array([1, 0, 0])))) };
}

function seededStore(): FakeStore {
  const store = new FakeStore();
  const messages = [
    makeMessage({ id: 'm1' }),
    makeMessage({ id: 'm2', role: 'assistant', source: 'assistant_text', contentText: '好的，先看一下现有代码' }),
  ];
  store.details.set('codex:s1', makeDetail('codex:s1', messages));
  store.needing = [{ id: 'codex:s1', messageCount: 2 }];
  return store;
}

describe('buildDigestTranscript', () => {
  it('keeps the newest messages within the character budget', () => {
    const messages = [
      makeMessage({ id: 'old', contentText: 'x'.repeat(500) }),
      makeMessage({ id: 'mid', contentText: 'y'.repeat(500) }),
      makeMessage({ id: 'new', contentText: '最新的一条消息' }),
    ];
    const transcript = buildDigestTranscript(messages, 600);
    expect(transcript).toContain('最新的一条消息');
    expect(transcript).toContain('y'.repeat(50));
    expect(transcript).not.toContain('x'.repeat(500));
    expect(transcript.length).toBeLessThanOrEqual(600);
  });

  it('summarizes tool calls and skips empty messages', () => {
    const messages = [
      makeMessage({
        id: 'tool',
        role: 'assistant',
        source: 'tool_request',
        contentText: undefined,
        contentToolName: 'Edit',
        contentToolOutput: 'done'.repeat(200),
      }),
      makeMessage({ id: 'empty', contentText: '   ' }),
    ];
    const transcript = buildDigestTranscript(messages);
    expect(transcript).toContain('工具：Edit');
    expect(transcript).toContain('工具结果：');
    expect(transcript.length).toBeLessThan(800);
  });
});

describe('DigestService', () => {
  it('writes a full digest with embedding on the happy path', async () => {
    const store = seededStore();
    const agent = makeAgent(async () => ({ content: JSON.stringify(GOOD_PAYLOAD) } as never));
    const embedding = makeEmbedding();
    const service = new DigestService(store, agent, embedding);

    await service.enqueuePending();

    const digest = store.digests.get('codex:s1');
    expect(digest).toBeDefined();
    expect(digest!.oneLiner).toBe(GOOD_PAYLOAD.one_liner);
    expect(digest!.keyTopics).toEqual(GOOD_PAYLOAD.key_topics);
    expect(digest!.keyFiles).toEqual(GOOD_PAYLOAD.key_files);
    expect(digest!.decisions).toEqual(GOOD_PAYLOAD.decisions);
    expect(digest!.openQuestions).toEqual(GOOD_PAYLOAD.open_questions);
    expect(digest!.embeddingStatus).toBe('ok');
    expect(digest!.embedding).toBeInstanceOf(Buffer);
    expect(digest!.digestVersion).toBe(DIGEST_VERSION);
    expect(digest!.messageCount).toBe(2);
    expect(digest!.platform).toBe('codex');
    expect(digest!.projectKey).toMatch(/^cli_[0-9a-f]{16}$/);

    // Digest runs never pollute the user-facing agent result log.
    expect(agent.run).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'digest', sessionId: 'codex:s1' }),
      { persist: false },
    );
    // Embedding text is one_liner + topics joined.
    const embedInput = (embedding.embed as ReturnType<typeof vi.fn>).mock.calls[0][0][0];
    expect(embedInput).toContain(GOOD_PAYLOAD.one_liner);
    expect(embedInput).toContain('认证');
  });

  it('retries once on malformed JSON and then succeeds', async () => {
    const store = seededStore();
    let calls = 0;
    const agent = makeAgent(async () => {
      calls += 1;
      if (calls === 1) return { content: '抱歉，我无法输出 JSON' } as never;
      return { content: JSON.stringify(GOOD_PAYLOAD) } as never;
    });
    const service = new DigestService(store, agent, makeEmbedding());

    await service.enqueuePending();

    expect(agent.run).toHaveBeenCalledTimes(2);
    expect(store.digests.get('codex:s1')!.oneLiner).toBe(GOOD_PAYLOAD.one_liner);
  });

  it('degrades to a structural row after two malformed outputs', async () => {
    const store = seededStore();
    const agent = makeAgent(async () => ({ content: 'not json at all' } as never));
    const embedding = makeEmbedding();
    const service = new DigestService(store, agent, embedding);

    await service.enqueuePending();

    expect(agent.run).toHaveBeenCalledTimes(2);
    const digest = store.digests.get('codex:s1')!;
    expect(digest.oneLiner).toBe('帮我实现登录功能');
    expect(digest.keyTopics).toEqual([]);
    expect(digest.embeddingStatus).toBe('skipped');
    expect(embedding.embed).not.toHaveBeenCalled();
  });

  it('degrades when the LLM is not configured', async () => {
    const store = seededStore();
    const agent = makeAgent(async () => {
      throw new Error('请先在设置中填写 API Key');
    });
    const service = new DigestService(store, agent, makeEmbedding());

    await service.enqueuePending();

    const digest = store.digests.get('codex:s1')!;
    expect(digest.oneLiner).toBe('帮我实现登录功能');
    expect(digest.embeddingStatus).toBe('skipped');
  });

  it('marks embedding as skipped when the embedding service is unavailable', async () => {
    const store = seededStore();
    const agent = makeAgent(async () => ({ content: JSON.stringify(GOOD_PAYLOAD) } as never));
    const embedding = makeEmbedding(async () => {
      throw new Error('Embedding 服务不可用');
    });
    const service = new DigestService(store, agent, embedding);

    await service.enqueuePending();

    const digest = store.digests.get('codex:s1')!;
    expect(digest.oneLiner).toBe(GOOD_PAYLOAD.one_liner);
    expect(digest.embeddingStatus).toBe('skipped');
    expect(digest.embedding).toBeNull();
  });

  it('dedupes sessions already in the queue', async () => {
    const store = seededStore();
    store.needing = [
      { id: 'codex:s1', messageCount: 2 },
      { id: 'codex:s1', messageCount: 2 },
    ];
    const agent = makeAgent(async () => ({ content: JSON.stringify(GOOD_PAYLOAD) } as never));
    const service = new DigestService(store, agent, makeEmbedding());

    await service.enqueuePending();

    expect(agent.run).toHaveBeenCalledTimes(1);
  });

  it('retries hard failures up to twice, then gives up without throwing', async () => {
    const store = seededStore();
    store.upsertSessionDigest = () => {
      throw new Error('database is locked');
    };
    const agent = makeAgent(async () => ({ content: JSON.stringify(GOOD_PAYLOAD) } as never));
    const service = new DigestService(store, agent, makeEmbedding());

    await expect(service.enqueuePending()).resolves.toBeUndefined();
    // 1 initial attempt + 2 retries; then the failed-row write also fails silently.
    expect(agent.run).toHaveBeenCalledTimes(3);
    expect(store.digests.size).toBe(0);
  });

  it('skips sessions with no usable content', async () => {
    const store = new FakeStore();
    store.details.set('codex:empty', makeDetail('codex:empty', [
      makeMessage({ id: 'blank', contentText: '   ' }),
    ]));
    store.needing = [{ id: 'codex:empty', messageCount: 1 }];
    const agent = makeAgent(async () => ({ content: JSON.stringify(GOOD_PAYLOAD) } as never));
    const service = new DigestService(store, agent, makeEmbedding());

    await service.enqueuePending();

    expect(agent.run).not.toHaveBeenCalled();
    expect(store.digests.size).toBe(0);
  });
});
