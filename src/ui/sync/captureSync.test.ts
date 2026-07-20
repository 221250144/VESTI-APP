// captureSync import planning: fingerprint diffing must skip unchanged
// conversations wholesale, detect the append/streaming growth patterns CLI
// captures actually produce, preserve user-curated fields on changed rows,
// and reconcile only local_terminal records.

import { describe, expect, it } from "vitest";
import {
  computeBundleFingerprint,
  planImport,
} from "./captureSync";
import type {
  ConversationExportBundle,
  VestiConversationRecord,
  VestiMessageRecord,
} from "../../shared/contracts";

function makeConversation(
  id: number,
  overrides: Partial<VestiConversationRecord> = {}
): VestiConversationRecord {
  return {
    id,
    uuid: `uuid-${id}`,
    platform: "kimi-code",
    title: `Session ${id}`,
    snippet: `snippet ${id}`,
    url: "",
    source_created_at: 1_000,
    first_captured_at: 1_000,
    last_captured_at: 2_000,
    created_at: 1_000,
    updated_at: 2_000,
    message_count: 2,
    turn_count: 1,
    is_archived: false,
    is_trash: false,
    tags: [],
    topic_id: null,
    is_starred: false,
    _source: "local_terminal",
    _cli_id: `cli-${id}`,
    _cli_platform: "kimi",
    ...overrides,
  };
}

function makeMessage(
  id: number,
  conversationId: number,
  content: string,
  role: "user" | "ai" = "user"
): VestiMessageRecord {
  return {
    id,
    conversation_id: conversationId,
    role,
    content_text: content,
    content_ast: null,
    content_ast_version: null,
    degraded_nodes_count: 0,
    citations: [],
    attachments: [],
    artifacts: [],
    normalized_html_snapshot: null,
    created_at: 1_000 + id,
    _source: "local_terminal",
  };
}

function makeBundle(
  id: number,
  messageTexts: string[],
  conversationOverrides: Partial<VestiConversationRecord> = {}
): ConversationExportBundle {
  return {
    conversation: makeConversation(id, {
      message_count: messageTexts.length,
      ...conversationOverrides,
    }),
    messages: messageTexts.map((text, index) =>
      makeMessage(id * 100 + index, id, text, index % 2 === 0 ? "user" : "ai")
    ),
  };
}

describe("computeBundleFingerprint", () => {
  it("is deterministic and sensitive to message growth", () => {
    const bundle = makeBundle(1, ["hello", "world"]);
    expect(computeBundleFingerprint(bundle.conversation, bundle.messages)).toBe(
      computeBundleFingerprint(bundle.conversation, bundle.messages)
    );
    const grown = makeBundle(1, ["hello", "world", "new tail"]);
    expect(
      computeBundleFingerprint(grown.conversation, grown.messages)
    ).not.toBe(computeBundleFingerprint(bundle.conversation, bundle.messages));
  });

  it("detects in-place content edits of the same length via updated_at", () => {
    const before = makeBundle(1, ["hello"]);
    const after = makeBundle(1, ["HELLO"], { updated_at: 3_000 });
    expect(
      computeBundleFingerprint(after.conversation, after.messages)
    ).not.toBe(computeBundleFingerprint(before.conversation, before.messages));
  });
});

describe("planImport", () => {
  it("puts new conversations with a stamped fingerprint", () => {
    const bundle = makeBundle(1, ["a", "b"]);
    const plan = planImport([bundle], []);
    expect(plan.toPut).toHaveLength(1);
    expect(plan.changedIds).toEqual([1]);
    expect(plan.changedMessages).toHaveLength(2);
    expect(plan.staleIds).toEqual([]);
    expect(
      (plan.toPut[0] as { _sync_fingerprint?: number })._sync_fingerprint
    ).toBe(computeBundleFingerprint(bundle.conversation, bundle.messages));
  });

  it("skips conversations whose fingerprint matches the stored record", () => {
    const bundle = makeBundle(1, ["a", "b"]);
    const fingerprint = computeBundleFingerprint(
      bundle.conversation,
      bundle.messages
    );
    const previous = [
      {
        ...bundle.conversation,
        topic_id: 7,
        is_starred: true,
        _sync_fingerprint: fingerprint,
      },
    ];
    const plan = planImport([bundle], previous as never);
    expect(plan.toPut).toHaveLength(0);
    expect(plan.changedIds).toEqual([]);
    expect(plan.changedMessages).toEqual([]);
    expect(plan.staleIds).toEqual([]);
  });

  it("re-imports records from before the fingerprint era once", () => {
    const bundle = makeBundle(1, ["a"]);
    const legacy = [{ ...bundle.conversation }];
    const plan = planImport([bundle], legacy as never);
    expect(plan.toPut).toHaveLength(1);
  });

  it("preserves user-curated fields when a conversation changed", () => {
    const before = makeBundle(1, ["a"]);
    const after = makeBundle(1, ["a", "b"]);
    const previous = [
      {
        ...before.conversation,
        topic_id: 42,
        is_starred: true,
        is_trash: true,
        is_archived: true,
        tags: ["keep"],
        auto_classified: 1,
        _sync_fingerprint: computeBundleFingerprint(
          before.conversation,
          before.messages
        ),
      },
    ];
    const plan = planImport([after], previous as never);
    expect(plan.toPut).toHaveLength(1);
    const merged = plan.toPut[0] as unknown as Record<string, unknown>;
    expect(merged.topic_id).toBe(42);
    expect(merged.is_starred).toBe(true);
    expect(merged.is_trash).toBe(true);
    expect(merged.is_archived).toBe(true);
    expect(merged.tags).toEqual(["keep"]);
    expect(merged.auto_classified).toBe(1);
  });

  it("reconciles only local_terminal records absent from the snapshot", () => {
    const bundle = makeBundle(1, ["a"]);
    const fingerprint = computeBundleFingerprint(
      bundle.conversation,
      bundle.messages
    );
    const previous = [
      { ...bundle.conversation, _sync_fingerprint: fingerprint },
      { ...makeConversation(2), _sync_fingerprint: 1 },
      // Browser-extension records share the table but must never be
      // reconciled away by a capture snapshot.
      { ...makeConversation(3, { message_count: 5 }), _source: "browser_extension" },
    ];
    const plan = planImport([bundle], previous as never);
    expect(plan.staleIds).toEqual([2]);
    expect(plan.toPut).toHaveLength(0);
  });
});
