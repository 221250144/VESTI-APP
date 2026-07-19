/**
 * Strip system-injected context blocks from message text.
 *
 * Several agents prepend machine-generated context to user messages:
 * - Codex wraps environment info in `<environment_context>…</environment_context>`
 *   (and instructions in `<user_instructions>…</user_instructions>`)
 * - Kimi Code prefixes prompts with a self-closing `<git-context …/>` line
 *
 * These blocks must stay in the stored message record, but they are not the
 * user's own words — titles, summaries and first-prompt extraction should
 * look past them.
 */

const INJECTED_BLOCK_PATTERNS: RegExp[] = [
  /<environment_context\b[^>]*>[\s\S]*?<\/environment_context>/g,
  /<user_instructions\b[^>]*>[\s\S]*?<\/user_instructions>/g,
  /<git-context\b[^>]*\/>/g,
  /<git-context\b[^>]*>[\s\S]*?<\/git-context>/g,
];

/** Remove injected context blocks and trim; the real user text remains. */
export function stripInjectedContextBlocks(text: string): string {
  let result = text;
  for (const pattern of INJECTED_BLOCK_PATTERNS) {
    result = result.replace(pattern, ' ');
  }
  return result.replace(/\s+/g, ' ').trim();
}
