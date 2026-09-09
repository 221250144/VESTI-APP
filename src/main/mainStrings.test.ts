import { describe, expect, it } from 'vitest';
import {
  embeddingStrings,
  formatMainString,
  llmStrings,
  outputLanguageForLocale,
  resolveMainLocale,
  settingsStrings,
} from './mainStrings';

describe('resolveMainLocale', () => {
  it('reads the ui-prefs language object and raw BCP-47 tags', () => {
    expect(resolveMainLocale({ locale: 'zh', userOverridden: true })).toBe('zh');
    expect(resolveMainLocale({ locale: 'en' })).toBe('en');
    expect(resolveMainLocale('ja-JP')).toBe('ja');
    expect(resolveMainLocale('ko-KR')).toBe('ko');
    expect(resolveMainLocale('zh-CN')).toBe('zh');
    expect(resolveMainLocale('en-US')).toBe('en');
  });

  it('falls back to Chinese (legacy factory language) for absent/unknown values', () => {
    expect(resolveMainLocale(undefined)).toBe('zh');
    expect(resolveMainLocale(null)).toBe('zh');
    expect(resolveMainLocale({})).toBe('zh');
    expect(resolveMainLocale('fr-FR')).toBe('zh');
  });
});

describe('outputLanguageForLocale', () => {
  it('maps every UI locale to its agent output language', () => {
    expect(outputLanguageForLocale('zh')).toBe('zh-CN');
    expect(outputLanguageForLocale('en')).toBe('en-US');
    expect(outputLanguageForLocale('ja')).toBe('ja-JP');
    expect(outputLanguageForLocale('ko')).toBe('ko-KR');
  });
});

describe('formatMainString', () => {
  it('fills placeholders and leaves unknown ones intact', () => {
    expect(formatMainString('连接成功：{model}', { model: 'gpt-4o' })).toBe('连接成功：gpt-4o');
    expect(formatMainString('{a} {missing}', { a: 'x' })).toBe('x {missing}');
  });
});

describe('main-process string tables', () => {
  it('keeps the English BYOK path free of CJK scaffolding', () => {
    const llm = llmStrings('en');
    expect(llm.apiKeyMissing).not.toMatch(/[぀-ヿ一-鿿가-힯]/);
    expect(llm.testSuccess).not.toMatch(/[぀-ヿ一-鿿가-힯]/);
    expect(llm.testFailed).not.toMatch(/[぀-ヿ一-鿿가-힯]/);
    expect(settingsStrings('en').byokBaseUrlRequired).not.toMatch(/[぀-ヿ一-鿿가-힯]/);
    expect(embeddingStrings('en').requestFailed).not.toMatch(/[぀-ヿ一-鿿가-힯]/);
  });

  it('gives ja/ko their own translations instead of the Chinese text', () => {
    for (const locale of ['en', 'ja', 'ko'] as const) {
      expect(llmStrings(locale).apiKeyMissing).not.toBe(llmStrings('zh').apiKeyMissing);
      expect(llmStrings(locale).testSuccess).not.toBe(llmStrings('zh').testSuccess);
      expect(settingsStrings(locale).byokBaseUrlRequired).not.toBe(settingsStrings('zh').byokBaseUrlRequired);
      expect(embeddingStrings(locale).requestFailed).not.toBe(embeddingStrings('zh').requestFailed);
    }
  });
});
