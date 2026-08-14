// Client-side PII gate for the RL data-contribution upload
// (docs/PRIVACY-DATA-CONTRIBUTION.md). Any session whose text matches one of
// these patterns is excluded whole — never uploaded. The patterns mirror the
// server-side re-check in deploy/vesti-gate/server.mjs exactly; keep both in
// sync when adding or tuning a pattern.

import type { ConversationExportBundle } from '../shared/contracts';

const PII_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'cn-phone', pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  { name: 'email', pattern: /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/ },
  { name: 'cn-id-card', pattern: /(?<!\d)\d{17}[\dXx](?!\d)/ },
  { name: 'bank-card', pattern: /(?<!\d)\d{16,19}(?!\d)/ },
  { name: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'aws-access-key', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'openai-key', pattern: /(?<![A-Za-z0-9])sk-[A-Za-z0-9]{16,}/ },
];

/** Returns the matched pattern name, or null when the text is clean. */
export function containsPii(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const { name, pattern } of PII_PATTERNS) {
    if (pattern.test(text)) return name;
  }
  return null;
}

/**
 * Scans every text-bearing field of an export bundle: conversation title and
 * snippet, plus each message's content/thinking/tool input/tool output.
 * Returns the first matched pattern name, or null when the session is clean.
 */
export function sessionContainsPii(bundle: ConversationExportBundle): string | null {
  const conversationHit = containsPii(bundle.conversation.title)
    ?? containsPii(bundle.conversation.snippet);
  if (conversationHit) return conversationHit;
  for (const message of bundle.messages) {
    const messageHit = containsPii(message.content_text)
      ?? containsPii(message._thinking)
      ?? containsPii(message._tool_input)
      ?? containsPii(message._tool_output);
    if (messageHit) return messageHit;
  }
  return null;
}
