// Quick-ask answer rendering: minimal Markdown → HTML for the capsule panel.
// Raw HTML in the source is escaped BEFORE parsing, so only marked-generated
// tags can appear in the output — the answer comes from the LLM and may embed
// recalled session text, so it is never trusted as HTML. (Same role as
// DOMPurify in the main window, but the capsule stays dependency-light.)

import { marked } from 'marked';

/** Render an LLM answer to safe HTML (markdown supported, raw HTML inert). */
export function renderAnswerHtml(source: string): string {
  const escaped = source
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const html = marked.parse(escaped, { gfm: true, breaks: true, async: false }) as string;
  // Defense in depth: drop scriptable link targets marked may still emit.
  return html.replace(/<a\s+href="(?:javascript:|data:|vbscript:)[^"]*"/gi, '<a');
}
