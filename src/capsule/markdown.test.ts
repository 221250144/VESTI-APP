import { describe, expect, it } from 'vitest';
import { renderAnswerHtml } from './markdown';

describe('renderAnswerHtml', () => {
  it('renders basic markdown (bold, lists, code)', () => {
    const html = renderAnswerHtml('重点：**先备份**。\n\n- 第一步\n- 第二步\n\n`npm test`');
    expect(html).toContain('<strong>先备份</strong>');
    expect(html).toContain('<li>第一步</li>');
    expect(html).toContain('<code>npm test</code>');
  });

  it('keeps raw HTML inert (rendered as visible text, never as tags)', () => {
    const html = renderAnswerHtml('看这里 <script>alert(1)</script> <img src=x onerror=alert(2)>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });

  it('strips scriptable link targets', () => {
    const html = renderAnswerHtml('[点我](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
  });

  it('passes plain text through as a paragraph', () => {
    expect(renderAnswerHtml('普通回答')).toContain('<p>普通回答</p>');
  });
});
