import type { Note } from "./types";

export const MOCK_NOTES: Note[] = [
  {
    id: 1,
    title: "Thoughts on Virtual List Performance",
    content: `## My Understanding

The core insight from the React virtual list conversation is that DOM node count is the real bottleneck, not JS computation.

## Key Takeaways
- react-window is sufficient for most cases
- Only reach for @tanstack/virtual when you need headless flexibility
- Dynamic height measurement has hidden costs

## Questions to Explore
- [ ] How does overscan affect perceived scroll performance?
- [ ] Is there a meaningful difference at 10k vs 100k items?

[[如何用 React 实现虚拟列表优化]]`,
    excerpt:
      "My Understanding The core insight from the React virtual list conversation is that DOM node count is the real bottleneck, not JS computation.",
    hash: "mock-note-1",
    linked_conversation_ids: [1],
    created_at: Date.now() - 50000,
    updated_at: Date.now() - 30000,
    source_type: "native",
    source_path: null,
    import_meta: null,
    obsidian_export: null,
  },
  {
    id: 2,
    title: "Chrome Extension Architecture Notes",
    content: `## Framework Comparison

After the Plasmo conversation, my current thinking:

**Plasmo** wins for DX — hot reload, TypeScript out of the box, good abstractions over MV3.

**WXT** is worth watching — more flexible but less mature ecosystem.

## Open Questions
- [ ] How does Plasmo handle side panel lifecycle?
- [ ] Content script injection timing with SPAs

[[Building a Chrome Extension with Plasmo]]`,
    excerpt:
      "Framework Comparison After the Plasmo conversation, my current thinking: Plasmo wins for DX hot reload, TypeScript out of the box.",
    hash: "mock-note-2",
    linked_conversation_ids: [5],
    created_at: Date.now() - 432000000,
    updated_at: Date.now() - 400000000,
    source_type: "native",
    source_path: null,
    import_meta: null,
    obsidian_export: null,
  },
  {
    id: 3,
    title: "Rust vs TypeScript Type System Comparison",
    content: `## Unstructured Thoughts

Coming from TypeScript, Rust's ownership model feels like type safety taken to its logical extreme. The borrow checker is annoying until it isn't.

TypeScript gives you escape hatches (any, as). Rust doesn't. That's both the frustration and the point.

## Worth Re-reading
[[Rust ownership 机制详解]]`,
    excerpt:
      "Unstructured Thoughts Coming from TypeScript, Rust's ownership model feels like type safety taken to its logical extreme.",
    hash: "mock-note-3",
    linked_conversation_ids: [2],
    created_at: Date.now() - 259200000,
    updated_at: Date.now() - 250000000,
    source_type: "native",
    source_path: null,
    import_meta: null,
    obsidian_export: null,
  },
  {
    id: 4,
    title: "Independent Reading Log",
    content: `## Books & Articles

Not linked to any specific conversation — just personal reading notes.

- *A Philosophy of Software Design* — Ousterhout's argument against comment-driven development is compelling
- Incremental complexity is the real enemy, not complexity per se
- "Tactical vs Strategic programming" is a useful mental model`,
    excerpt:
      'Books & Articles Not linked to any specific conversation just personal reading notes. A Philosophy of Software Design Tactical vs Strategic.',
    hash: "mock-note-4",
    linked_conversation_ids: [],
    created_at: Date.now() - 600000000,
    updated_at: Date.now() - 580000000,
    source_type: "native",
    source_path: null,
    import_meta: null,
    obsidian_export: null,
  },
];
