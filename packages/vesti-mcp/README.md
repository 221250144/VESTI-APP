# @vesti/vesti-mcp

Read-only MCP server that lets AI coding agents (kimi-code, Claude Code, codex, …) search the conversation memory that VESTI has captured locally (`~/.vesti/db/vesti.db`).

The agent registers this package as a local stdio MCP server. On session start it can pull a project's **automatic context pack** in one call; deeper history goes through **three progressive-disclosure layers** — cheap index first, full content only at the end:

| Layer | Tool | Cost | What it returns |
| --- | --- | --- | --- |
| 0 | `vesti_get_project_context(paths?, session_limit?, brief_chars?)` | one pack per project | **Session-start context**: L0 state card + L2 brief + recent sessions (title/time/one-liner) + merged open questions + deterministic active-file timeline, per project path. Multiple paths = merge mode: a `cross_project` section adds shared files, shared topics and overlapping work windows. No paths = most recently active project. |
| 1 | `vesti_search(query, topK=8)` | ~100 tokens/entry | Session index entries: `session_id`, title, platform, project path, time, digest `one_liner`, `key_topics`, hit snippet |
| 2 | `vesti_timeline(session_id, around_turn?)` | ~30 tokens/turn | Turn outline of one session: seq, time, one-line user intent, tool-call count, tokens |
| 3 | `vesti_get_turns(session_id, turn_ids \| range, max_chars=8000)` | bounded by `max_chars` | Full user/assistant message text + tool-call summaries for the selected turns; sets `truncated: true` when the budget cuts output |
| — | `vesti_project_brief(project)` | one card + one doc | Project memory by fuzzy name: L0 "current state card" + L2 LLM-maintained brief. Prefer `vesti_get_project_context` when you know the path. |
| — | `vesti_get_handoff_context(path \| session_id, user_messages=8)` | one pack | Light handoff material aligned with the app's relay v2 schema: the project block + newest user messages + file anchors + `verify_first` seeds (open questions to re-confirm, last failing steps to re-run). All machine-extracted; heavy transcript compression stays in the desktop app. |
| M1 | `vesti_memory_search(query?, kind?, entry_date?, limit=10)` | ~150 tokens/entry | **Memory space** (schema v14) index entries: `id`, kind, title, summary, entry_date, tags, updated_at, ~160-char snippet. With a query it FTS-matches title/content/tags; without one it browses newest first. `kind` ∈ `deposit` / `dream` / `dream-log` / `note`; active entries only unless `include_archived`. |
| M2 | `vesti_memory_get(ids, include_archived?)` | full docs | Full memory documents by id (max 10): complete `content_markdown`, parsed `source_session_ids`/`tags`, version chain (`version`, `prev_id`), timestamps. Unknown ids come back in `missing`. |
| F | `vesti_search_files(query, topK=10)` | ~80 tokens/file | **File-level memory**: which local files past work about a topic lives in. Evidence channels: the path contains a query token (`matched_via: "name"`) or a recalled session touched the file (`"session-content"`, from digest `key_files` + tool-call inputs). Returns path, projects, backing sessions, touches, `last_touched` — the agent reads the files itself with its own filesystem tools. |

The server's MCP `instructions` tell the connecting agent the behavior contract directly: call `vesti_get_project_context` with its cwd at session start, use multi-path mode for merges, `vesti_get_handoff_context` before handing off, and never call `vesti_get_turns` without narrowing through search + timeline first. The memory space has the same two-step discipline: `vesti_memory_search` (or browse) → `vesti_memory_get` only for the ids worth reading in full. `deposit` entries are the user's long-term deposit documents (profile, project state, writing style); `dream` entries are durable facts about the user themself (preferences, goals, emotions) extracted by the dream pass; `dream-log` entries are the per-run logs of that pass. On a pre-v14 database the memory tools answer with a friendly "memory space not set up" message instead of an error stack.

Recall is FTS5-based (over `messages_fts` + `sessions_fts`, RRF-fused — the same ranking as capture-core's `SessionRecall`). Digest embeddings are only fused when an embedding service supplies a query vector; the MCP server has none, so it degrades to pure FTS exactly as `SessionRecall` does without a vector.

## Requirements

- **Node ≥ 23.4** (uses the built-in `node:sqlite` module). On Node 22.x it also works if you pass `--experimental-sqlite` to node (see configs below).
- A VESTI database at `~/.vesti/db/vesti.db` (created by the VESTI desktop app or CLI capture). Override with the `VESTI_DB_PATH` environment variable.

The server never modifies captured content. Its single write is `session_digests.access_count + 1` for the digests `vesti_search` surfaces (memory v2 L1 access tracking); on a pre-v4 database without that column the bump is skipped silently. Because it uses `node:sqlite` instead of better-sqlite3, it is immune to the Electron-vs-Node ABI mismatch of the desktop app's native module.

## Build

```bash
corepack pnpm install
corepack pnpm --filter @vesti/vesti-mcp build   # outputs dist/cli.js (+ dist/index.js)
corepack pnpm --filter @vesti/vesti-mcp test
```

## Register in your agent

The fastest route is the VESTI desktop app: **Settings → Connect to agents** detects installed agents and writes/removes the registration in one click (merge-only, backs up the original config first). Manual registration works too — replace `<PKG>` with the absolute path to this package, e.g. `C:/Users/you/项目开发/VESTI-APP/packages/vesti-mcp`.

### kimi-code

User level: `~/.kimi-code/mcp.json` — project level: `.kimi-code/mcp.json` (or use `/mcp-config` in the TUI):

```json
{
  "mcpServers": {
    "vesti": {
      "command": "node",
      "args": ["<PKG>/dist/cli.js"]
    }
  }
}
```

### Claude Code

Project level: `.mcp.json` in the repo — or run `claude mcp add vesti -- node <PKG>/dist/cli.js`:

```json
{
  "mcpServers": {
    "vesti": {
      "command": "node",
      "args": ["<PKG>/dist/cli.js"]
    }
  }
}
```

### codex

`~/.codex/config.toml`:

```toml
[mcp_servers.vesti]
command = "node"
args = ["<PKG>/dist/cli.js"]
```

### Variants

- **Custom db location**: add `"env": { "VESTI_DB_PATH": "D:/path/to/vesti.db" }` to the JSON entries (kimi-code / Claude Code), or `env = { VESTI_DB_PATH = "D:/path/to/vesti.db" }` in codex's TOML.
- **Node 22.x**: put the flag before the script — `"args": ["--experimental-sqlite", "<PKG>/dist/cli.js"]`.
- **npx-style** (once the package is published): `"args": ["-y", "@vesti/vesti-mcp"]`.

## Guidance for the agent (paste into CLAUDE.md / AGENTS.md)

```text
## VESTI memory recall

A `vesti` MCP server exposes my past AI-coding sessions. At session start in
a tracked project, call `vesti_get_project_context` with your cwd first —
it returns the project's state card, brief, recent sessions, open questions
and active-file timeline in one call (pass several project paths for merge
work; it also reports cross-project links). Only then fill the gaps:

1. `vesti_search` with a few keywords → session candidates (~100 tokens each).
2. `vesti_timeline` on the best session_id → turn outline; locate the passage.
3. `vesti_get_turns` with only the turn seq numbers you need → full content.

Long-term memory about me (profile, preferences, project state, dream-pass
logs) lives in the memory space: `vesti_memory_search` (keywords, or no query
to browse) → `vesti_memory_get` with only the ids worth reading in full.

Before handing work to another agent/session, `vesti_get_handoff_context`
ships file anchors, recent user messages and verify-first seeds. Never call
vesti_get_turns without narrowing via search + timeline first; it is the
expensive layer and truncates at max_chars anyway. All data is local.
```

## Output contract (examples)

`vesti_search({ query: "transactional migrations" })` →

```json
{
  "query": "transactional migrations",
  "count": 1,
  "results": [
    {
      "session_id": "ws-aaa-001",
      "title": "Refactoring the sqlite storage layer",
      "platform": "claude-code",
      "host": "native",
      "project_path": "C:/work/vesti",
      "started_at": "2026-01-10T12:00:00.000Z",
      "one_liner": "Made the sqlite migration runner transactional",
      "key_topics": ["sqlite", "migrations", "transactions"],
      "snippet": "…wrap every migration step in a transaction…",
      "score": 0.032254,
      "confidence": "high"
    }
  ]
}
```

`confidence` is the abstention signal: `'low'` when the hit's best message
literally covers less than half of the matchable query tokens (or the query
has none — e.g. only tokens shorter than 3 characters under the trigram
tokenizer). Treat a `'low'` top entry as "probably not in the archive"
instead of quoting its snippet. Scores are RRF-fused and recency-decayed
(newer sessions rank higher, all else equal).

`vesti_timeline({ session_id: "ws-aaa-001" })` →

```json
{
  "session": { "session_id": "ws-aaa-001", "title": "…", "platform": "claude-code", "host": "native", "project_path": "C:/work/vesti", "started_at": "…", "ended_at": "…", "turn_count": 3, "message_count": 7 },
  "total_turns": 3,
  "showing": { "from_seq": 1, "to_seq": 3 },
  "turns": [
    { "seq": 1, "started_at": "…", "duration_ms": 45000, "user_intent": "please refactor the database migrations…", "tool_count": 1, "input_tokens": 1200, "output_tokens": 340 }
  ]
}
```

`vesti_get_turns({ session_id: "ws-aaa-001", turn_ids: [1] })` →

```json
{
  "session_id": "ws-aaa-001",
  "requested": 1,
  "returned": 1,
  "truncated": false,
  "char_count": 312,
  "max_chars": 8000,
  "turns": [
    {
      "seq": 1,
      "started_at": "…",
      "user": "please refactor the database migrations to be transactional",
      "assistant": "I wrapped every migration step in a transaction and added rollback handling.",
      "thinking": "the migration runner should wrap each step in BEGIN/COMMIT",
      "tools": [
        { "tool": "Edit", "outcome": "success", "input_summary": "…/migrations.ts", "output_summary": "wrapped migration in transaction", "is_error": false }
      ]
    }
  ]
}
```

`vesti_get_project_context({ paths: ["C:/work/vesti", "C:/work/blog"] })` →

```json
{
  "generated_at": "2026-02-01T08:00:00.000Z",
  "projects": [
    {
      "path": "c:/work/vesti",
      "label": "vesti",
      "project_keys": ["cli_0123abcd…"],
      "platforms": ["claude-code", "kimi-code"],
      "session_count": 12,
      "last_active": "2026-01-31T15:04:00.000Z",
      "state": {
        "one_liner": "Made the sqlite migration runner transactional",
        "active_files": [{ "path": "src/storage/migrations.ts", "touches": 7, "last_touched": "2026-01-30T…" }],
        "open_questions": ["是否切换到 WAL2？"],
        "updated_at": "2026-01-31T…"
      },
      "brief": { "content_markdown": "# vesti 项目简报…", "version": 5, "updated_at": "2026-01-31T…", "truncated": false },
      "recent_sessions": [
        { "session_id": "ws-aaa-001", "title": "Refactoring the sqlite storage layer", "platform": "claude-code", "host": "native", "started_at": "2026-01-10T12:00:00.000Z", "one_liner": "Made the sqlite migration runner transactional", "key_topics": ["sqlite"] }
      ],
      "open_questions": ["是否切换到 WAL2？"],
      "active_files": [{ "path": "src/storage/migrations.ts", "touches": 7, "last_touched": "2026-01-30T…" }]
    }
  ],
  "unmatched_paths": [],
  "cross_project": {
    "shared_files": [{ "file": "storage/migrations.ts", "projects": ["blog", "vesti"] }],
    "shared_topics": [{ "topic": "sqlite", "projects": ["blog", "vesti"] }],
    "time_overlaps": [{ "projects": ["vesti", "blog"], "overlapping_session_pairs": 3, "latest_overlap": { "start": "2026-01-10T12:30:00.000Z", "end": "2026-01-10T13:00:00.000Z" } }]
  },
  "hints": []
}
```

One physical directory worked on by several agents yields several derived
project keys (the key hashes `platform|host|path`); the tool merges those
per-key memory layers into one project view. On pre-memory-v2 databases the
state card degrades to a digest-based fallback, and a path with no captured
sessions comes back in `unmatched_paths` with the known projects in `hints`.

`vesti_get_handoff_context({ path: "C:/work/vesti" })` →

```json
{
  "project": { "…": "same block as vesti_get_project_context" },
  "recent_user_messages": [
    { "session_id": "ws-aaa-001", "session_title": "Refactoring the sqlite storage layer", "timestamp": "2026-01-10T12:03:00.000Z", "text": "follow-up question 3" }
  ],
  "file_anchors": [{ "path": "src/storage/migrations.ts", "touches": 7, "last_touched": "2026-01-30T…" }],
  "verify_first": [
    { "check": "Confirm whether this is still unresolved: \"是否切换到 WAL2？\"", "source": "project open questions" },
    { "check": "Re-check the last failing step: Bash — npm run deploy", "source": "Deploying a static site (2026-01-11)" }
  ],
  "hints": ["Assemble the actual handoff with the relay v2 schema …"]
}
```

`vesti_memory_search({ query: "写作风格" })` →

```json
{
  "query": "写作风格",
  "kind": null,
  "count": 1,
  "results": [
    {
      "id": "mem-deposit-1",
      "kind": "deposit",
      "title": "个人背景与写作风格",
      "summary": "个人背景、写作风格与当前项目状态",
      "entry_date": "2026-01-05",
      "tags": ["profile", "writing"],
      "updated_at": "2026-01-05T12:00:00.000Z",
      "snippet": "# 个人背景 用户是独立开发者，笔名小蜂。写作风格：短句，口语化，先结论后论证。 当前项目：VESTI（本地 AI 会话记忆工具）。"
    }
  ]
}
```

`vesti_memory_get({ ids: ["mem-dream-1", "mem-nope"] })` →

```json
{
  "requested": 2,
  "count": 1,
  "missing": ["mem-nope"],
  "entries": [
    {
      "id": "mem-dream-1",
      "kind": "dream",
      "title": "用户偏好：简洁输出",
      "content_markdown": "用户多次要求输出保持简洁、先给结论，对冗长解释表现出不耐烦。涉及性能话题时情绪明显更投入。",
      "summary": "偏好简洁、结论先行的回答",
      "scope": null,
      "template": null,
      "source_session_ids": ["ws-aaa-001"],
      "tags": ["preference", "communication"],
      "version": 1,
      "prev_id": null,
      "last_ops": "[]",
      "status": "active",
      "entry_date": "2026-01-08",
      "created_at": "2026-01-08T12:00:00.000Z",
      "updated_at": "2026-01-08T12:00:00.000Z"
    }
  ]
}
```

## Layout

- `src/db.ts` — db path resolution (`VESTI_DB_PATH` → `~/.vesti/db/vesti.db`) and database open (write policy: only digest access-count bumps)
- `src/recall.ts` — FTS5 + RRF recall (port of capture-core `SessionRecall`, pure-FTS path)
- `src/tools.ts` — the three layer implementations + `vesti_project_brief`
- `src/memory.ts` — the memory-space pair `vesti_memory_search` / `vesti_memory_get` (schema v14, same tokenizer-aware FTS strategy as recall)
- `src/files.ts` — `vesti_search_files`: file-level index (recalled sessions' key_files + tool-input path extraction, name/content evidence channels)
- `src/projectContext.ts` — `vesti_get_project_context` / `vesti_get_handoff_context`: project key derivation (port of capture-core `projectRegistry`), per-key memory-layer merge, cross-project links
- `src/server.ts` — MCP wiring on the official `@modelcontextprotocol/sdk` (low-level `Server`, hand-written JSON Schemas, no zod), including the session-start behavior contract in `instructions`
- `src/cli.ts` — stdio entry (`bin: vesti-mcp`)
- `tests/` — vitest: tool contracts against a temp fixture db + protocol handshake over in-memory transports

When the database file is missing the CLI exits with guidance to run VESTI first; unknown sessions/tools are reported as MCP `isError` results.
