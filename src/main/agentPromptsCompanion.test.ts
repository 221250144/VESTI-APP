// 夜话 persona lock-in: the two system prompts carry the product's tone
// promises (gentle-but-strong listener, passionate creator, long warm comfort
// replies, memory honesty, the [mood:xxx] contract). These tests pin the key
// directives so a casual edit can't quietly drop them.

import { describe, expect, it } from 'vitest';
import { getAgentKindDefinition } from './agentPrompts';

const zhPreferences = {
  outputLanguage: 'zh-CN',
  includeThinking: false,
  includeToolDetails: false,
  customInstructions: '',
} as Parameters<ReturnType<typeof getAgentKindDefinition>['buildPrompt']>[0]['preferences'];

function systemOf(template?: string): string {
  const messages = getAgentKindDefinition('companion').buildPrompt({
    transcript: 'CONTEXT',
    question: '今天好累',
    template,
    preferences: zhPreferences,
  });
  return messages[0].content;
}

describe('companion listener persona', () => {
  it('stays the gentle listener who feels with the user before fixing', () => {
    const system = systemOf();
    expect(system.startsWith('你是「夜话」，Vesti 里的猫头鹰伙伴')).toBe(true);
    expect(system).toContain('温柔的倾听者');
    expect(system).toContain('先接住情绪，再谈事情');
  });

  it('locks the long-and-warm comfort directive for distress moments', () => {
    const system = systemOf('listener');
    // Comfort scenes (tired/sad/anxious/self-doubting) must get an expanded,
    // paragraph-form reply — a two-or-three-sentence brush-off is explicitly
    // forbidden.
    expect(system).toContain('累、难过、崩溃、焦虑或自我怀疑');
    expect(system).toContain('五到八句甚至更长');
    expect(system).toContain('绝对不许两三句敷衍收尾');
  });

  it('keeps the gentle-but-strong spine (温柔但有骨头)', () => {
    const system = systemOf();
    expect(system).toContain('温柔但有骨头');
    expect(system).toContain('有力量的温柔');
  });

  it('references dated memories and recall fragments naturally', () => {
    const system = systemOf();
    expect(system).toContain('来源平台与时间');
    expect(system).toContain('绝不');
    expect(system).toContain('根据我的记录');
  });

  it('keeps memory honesty and the mood-tag contract', () => {
    const system = systemOf();
    expect(system).toContain('记忆里没有的不要编造');
    expect(system).toContain('[mood:xxx]');
    expect(system).toContain('calm/thinking/delighted/spark/sleepy/warm');
  });
});

describe('companion creator persona', () => {
  it('stays the passionate, imaginative campfire', () => {
    const system = systemOf('creator');
    expect(system.startsWith('你是「夜话」的创造者人格')).toBe(true);
    expect(system).toContain('激情与想象力');
    expect(system).toContain('想象力要大胆');
  });

  it('comforts by igniting, with long concrete warmth instead of platitudes', () => {
    const system = systemOf('creator');
    expect(system).toContain('用想象力点火而不是讲大道理');
    expect(system).toContain('三两句的打气就是敷衍');
  });

  it('keeps the concrete next-step promise and honesty clauses', () => {
    const system = systemOf('creator');
    expect(system).toContain('可立刻尝试的想法、原型或下一步');
    expect(system).toContain('记忆里没有的不要编造');
    expect(system).toContain('[mood:xxx]');
  });
});
