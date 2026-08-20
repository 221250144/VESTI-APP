// captureSync import planning: fingerprint diffing must skip unchanged
// conversations wholesale, detect the append/streaming growth patterns CLI
// captures actually produce, preserve user-curated fields on changed rows,
// and reconcile only local_terminal records.

import { describe, expect, it } from "vitest";
import {
  buildAnnotationMessageRemap,
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
    const plan = planImport([bundle], [], ["cli-1"]);
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
    const plan = planImport([bundle], previous as never, ["cli-1"]);
    expect(plan.toPut).toHaveLength(0);
    expect(plan.changedIds).toEqual([]);
    expect(plan.changedMessages).toEqual([]);
    expect(plan.staleIds).toEqual([]);
  });

  it("re-imports records from before the fingerprint era once", () => {
    const bundle = makeBundle(1, ["a"]);
    const legacy = [{ ...bundle.conversation }];
    const plan = planImport([bundle], legacy as never, ["cli-1"]);
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
    const plan = planImport([after], previous as never, ["cli-1"]);
    expect(plan.toPut).toHaveLength(1);
    const merged = plan.toPut[0] as unknown as Record<string, unknown>;
    expect(merged.topic_id).toBe(42);
    expect(merged.is_starred).toBe(true);
    expect(merged.is_trash).toBe(true);
    expect(merged.is_archived).toBe(true);
    expect(merged.tags).toEqual(["keep"]);
    expect(merged.auto_classified).toBe(1);
  });

  it("keeps the legacy Dexie key when the stable CLI id matches", () => {
    const legacyId = 42_000_001;
    const currentHashId = 8_500_000_000_001;
    const bundle = makeBundle(currentHashId, ["new user turn", "new answer"], {
      _cli_id: "codex:stable-session-id",
      _cli_platform: "codex",
    });
    const previous = [
      {
        ...makeConversation(legacyId, {
          _cli_id: "codex:stable-session-id",
          _cli_platform: "codex",
        }),
        topic_id: 17,
        is_starred: true,
        tags: ["preserve-me"],
        _sync_fingerprint: 1,
      },
    ];

    const plan = planImport([bundle], previous as never, [
      "codex:stable-session-id",
    ]);

    expect(plan.staleIds).toEqual([]);
    expect(plan.changedIds).toEqual([legacyId]);
    expect(plan.toPut).toHaveLength(1);
    expect(plan.toPut[0]).toMatchObject({
      id: legacyId,
      _cli_id: "codex:stable-session-id",
      topic_id: 17,
      is_starred: true,
      tags: ["preserve-me"],
    });
    expect(plan.changedMessages).toHaveLength(2);
    expect(
      plan.changedMessages.every(
        (message) => message.conversation_id === legacyId
      )
    ).toBe(true);
  });

  it("does not mark a stable-id match stale when its numeric hash changed", () => {
    const legacyId = 55_000_001;
    const currentHashId = 8_700_000_000_001;
    const bundle = makeBundle(currentHashId, ["same content"], {
      _cli_id: "kimi:stable-session-id",
    });
    const previous = [
      {
        ...bundle.conversation,
        id: legacyId,
        _sync_fingerprint: computeBundleFingerprint(
          bundle.conversation,
          bundle.messages
        ),
      },
      {
        ...makeConversation(66_000_001),
        _cli_id: "removed-session",
        _sync_fingerprint: 1,
      },
    ];

    const plan = planImport([bundle], previous as never, [
      "kimi:stable-session-id",
    ]);

    expect(plan.toPut).toEqual([]);
    expect(plan.changedIds).toEqual([]);
    expect(plan.changedMessages).toEqual([]);
    expect(plan.staleIds).toEqual([66_000_001]);
  });

  it("reconciles only local_terminal records absent from the id list", () => {
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
    const plan = planImport([bundle], previous as never, ["cli-1"]);
    expect(plan.staleIds).toEqual([2]);
    expect(plan.toPut).toHaveLength(0);
  });

  it("keeps unchanged sessions that are absent from incremental bundles", () => {
    // Steady-state tick: main re-sent nothing, but both sessions still exist
    // upstream — nothing may be written or reconciled away.
    const previous = [
      { ...makeConversation(1), _sync_fingerprint: 1 },
      { ...makeConversation(2), _sync_fingerprint: 2 },
    ];
    const plan = planImport([], previous as never, ["cli-1", "cli-2"]);
    expect(plan.toPut).toEqual([]);
    expect(plan.changedIds).toEqual([]);
    expect(plan.changedMessages).toEqual([]);
    expect(plan.staleIds).toEqual([]);
  });

  it("marks sessions missing from the authoritative id list as stale", () => {
    const previous = [
      { ...makeConversation(1), _sync_fingerprint: 1 },
      { ...makeConversation(2), _sync_fingerprint: 2 },
    ];
    const plan = planImport([], previous as never, ["cli-1"]);
    expect(plan.staleIds).toEqual([2]);
  });

  it("retains mirror rows that predate _cli_id instead of guessing", () => {
    const legacy: Record<string, unknown> = { ...makeConversation(9) };
    delete legacy._cli_id;
    const plan = planImport([], [legacy] as never, ["cli-1"]);
    expect(plan.staleIds).toEqual([]);
  });

  it("does not wipe the local mirror when an export is transiently empty", () => {
    const previous = [
      { ...makeConversation(1), _cli_id: "codex:session-1" },
      { ...makeConversation(2), _cli_id: "cursor:session-2" },
    ];

    const plan = planImport([], previous as never, []);

    expect(plan.toPut).toEqual([]);
    expect(plan.changedIds).toEqual([]);
    expect(plan.changedMessages).toEqual([]);
    expect(plan.staleIds).toEqual([]);
  });
});

describe("buildAnnotationMessageRemap", () => {
  it("maps old split message ids to their new role-appropriate turn bubble", () => {
    const prompt = {
      ...makeMessage(100, 1, "主提示"),
      _member_message_ids: [100, 101],
    };
    const response = {
      ...makeMessage(200, 1, "最终答案", "ai"),
      _member_message_ids: [150, 151, 200],
    };

    const remap = buildAnnotationMessageRemap([prompt, response] as never);

    expect(remap.get(101)).toBe(100);
    expect(remap.get(150)).toBe(200);
    expect(remap.get(200)).toBe(200);
  });
});
