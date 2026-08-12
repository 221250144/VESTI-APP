import { describe, expect, it } from 'vitest';
import {
  DREAM_MEMORY_TAGS,
  parseDreamExtractPayload,
  parseDreamMaintainPayload,
} from './dreamMaintain';

describe('parseDreamExtractPayload', () => {
  it('parses a clean payload', () => {
    const raw = JSON.stringify({
      memories: [
        {
          tag: 'preference',
          fact: '偏好用 pnpm 管理依赖',
          evidence: '多次要求用 corepack pnpm 跑脚本',
          session_ids: ['kimi-code:s1'],
        },
      ],
    });
    expect(parseDreamExtractPayload(raw)).toEqual([
      {
        tag: 'preference',
        fact: '偏好用 pnpm 管理依赖',
        evidence: '多次要求用 corepack pnpm 跑脚本',
        session_ids: ['kimi-code:s1'],
      },
    ]);
  });

  it('tolerates Markdown fences and surrounding prose', () => {
    const raw = '好的，提取结果如下：\n```json\n{"memories": [{"tag": "goal", "fact": "在推进 Vesti 记忆空间", "evidence": "连续多天的开发记录", "session_ids": []}]}\n```\n以上。';
    const memories = parseDreamExtractPayload(raw);
    expect(memories).toHaveLength(1);
    expect(memories[0].tag).toBe('goal');
  });

  it('returns an empty array when the model finds nothing new', () => {
    expect(parseDreamExtractPayload('{"memories": []}')).toEqual([]);
    expect(parseDreamExtractPayload('{}')).toEqual([]);
  });

  it('drops malformed entries but keeps valid ones', () => {
    const raw = JSON.stringify({
      memories: [
        'not-an-object',
        { tag: 'unknown-tag', fact: '非法 tag' },
        { tag: 'profile', fact: '   ' },
        { tag: 'event', fact: '发布了 Vesti 0.3.0', evidence: 'release 记录', session_ids: ['codex:s2'] },
      ],
    });
    expect(parseDreamExtractPayload(raw)).toEqual([
      { tag: 'event', fact: '发布了 Vesti 0.3.0', evidence: 'release 记录', session_ids: ['codex:s2'] },
    ]);
  });

  it('caps memories at 30 and truncates long fact/evidence at 500 chars', () => {
    const raw = JSON.stringify({
      memories: Array.from({ length: 35 }, (_, i) => ({
        tag: 'profile',
        fact: `事实 ${i}`,
        evidence: 'e',
        session_ids: [],
      })),
    });
    expect(parseDreamExtractPayload(raw)).toHaveLength(30);

    const long = parseDreamExtractPayload(JSON.stringify({
      memories: [{ tag: 'emotion', fact: '长'.repeat(600), evidence: '证'.repeat(600), session_ids: [] }],
    }));
    expect(long[0].fact).toHaveLength(500);
    expect(long[0].evidence).toHaveLength(500);
  });

  it('filters non-string session ids and caps them at 20', () => {
    const raw = JSON.stringify({
      memories: [{
        tag: 'profile',
        fact: 'f',
        evidence: '',
        session_ids: [...Array.from({ length: 25 }, (_, i) => `s${i}`), 42, null, ''],
      }],
    });
    const memories = parseDreamExtractPayload(raw);
    expect(memories[0].session_ids).toHaveLength(20);
    expect(memories[0].session_ids.every(id => typeof id === 'string' && id)).toBe(true);
  });

  it('throws when the output is not a JSON object', () => {
    expect(() => parseDreamExtractPayload('随便一段散文')).toThrow('dream-extract 输出不是 JSON');
    // 数组里嵌着的合法对象仍会被容错提取（无 memories 字段 → 空数组）。
    expect(parseDreamExtractPayload('[{"tag":"profile"}]')).toEqual([]);
  });

  it('exposes exactly the six allowed tags', () => {
    expect(DREAM_MEMORY_TAGS).toEqual(['profile', 'preference', 'goal', 'emotion', 'relationship', 'event']);
  });
});

describe('parseDreamMaintainPayload', () => {
  it('parses a full op set', () => {
    const raw = JSON.stringify({
      ops: [
        { op: 'ADD', target_id: null, tag: 'goal', title: '推进记忆空间', content: '正在实现记忆空间存储层', reason: '全新事实' },
        { op: 'UPDATE', target_id: 'dream:abc', tag: 'preference', title: '包管理偏好', content: '偏好 pnpm（经 corepack）', reason: '补充细节' },
        { op: 'DELETE', target_id: 'dream:old', tag: null, title: '', content: '', reason: '已过时' },
        { op: 'NOOP', target_id: null, tag: null, title: '', content: '', reason: '与已有条目重复' },
      ],
    });
    expect(parseDreamMaintainPayload(raw)).toEqual([
      { op: 'ADD', target_id: null, tag: 'goal', title: '推进记忆空间', content: '正在实现记忆空间存储层', reason: '全新事实' },
      { op: 'UPDATE', target_id: 'dream:abc', tag: 'preference', title: '包管理偏好', content: '偏好 pnpm（经 corepack）', reason: '补充细节' },
      { op: 'DELETE', target_id: 'dream:old', tag: null, title: '', content: '', reason: '已过时' },
      { op: 'NOOP', target_id: null, tag: null, title: '', content: '', reason: '与已有条目重复' },
    ]);
  });

  it('tolerates fences and prose around the JSON', () => {
    const raw = '```json\n{"ops": [{"op": "NOOP", "target_id": null, "reason": "r"}]}\n```';
    expect(parseDreamMaintainPayload(raw)).toHaveLength(1);
  });

  it('drops ops that violate the target_id invariants', () => {
    const raw = JSON.stringify({
      ops: [
        { op: 'UPDATE', target_id: null, reason: '缺 target_id' },
        { op: 'DELETE', reason: '缺 target_id' },
        { op: 'ADD', target_id: 'dream:abc', reason: 'ADD 不应带 target_id' },
        { op: 'ADD', target_id: null, tag: 'event', title: 't', content: 'c', reason: '合法 ADD' },
        { op: 'MERGE', target_id: null, reason: '未知 op' },
        'not-an-object',
      ],
    });
    expect(parseDreamMaintainPayload(raw)).toEqual([
      { op: 'ADD', target_id: null, tag: 'event', title: 't', content: 'c', reason: '合法 ADD' },
    ]);
  });

  it('caps ops at 50 and truncates title/content', () => {
    const raw = JSON.stringify({
      ops: Array.from({ length: 60 }, () => ({ op: 'NOOP', target_id: null, reason: 'r' })),
    });
    expect(parseDreamMaintainPayload(raw)).toHaveLength(50);

    const long = parseDreamMaintainPayload(JSON.stringify({
      ops: [{ op: 'ADD', target_id: null, tag: 'profile', title: '题'.repeat(80), content: '文'.repeat(1200), reason: 'r' }],
    }));
    expect(long[0].title).toHaveLength(60);
    expect(long[0].content).toHaveLength(1000);
  });

  it('normalizes an unknown tag to null instead of failing the op', () => {
    const raw = JSON.stringify({
      ops: [{ op: 'ADD', target_id: null, tag: 'not-a-tag', title: 't', content: 'c', reason: 'r' }],
    });
    expect(parseDreamMaintainPayload(raw)[0].tag).toBeNull();
  });

  it('throws when the output is not a JSON object', () => {
    expect(() => parseDreamMaintainPayload('')).toThrow('dream-maintain 输出不是 JSON');
    expect(() => parseDreamMaintainPayload('[1,2]')).toThrow('dream-maintain 输出不是 JSON');
  });
});
