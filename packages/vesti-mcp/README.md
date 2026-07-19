# @vesti/vesti-mcp

Read-only MCP server that lets AI coding agents (kimi-code, Claude Code, codex, …) search the conversation memory that VESTI has captured locally (`~/.vesti/db/vesti.db`).

The agent registers this package as a local stdio MCP server, then recalls past sessions through **three progressive-disclosure layers** — cheap index first, full content only at the end:

| Layer | Tool | Cost | What it returns |
| --- | --- | --- | --- |
| 1 | `vesti_search(query, topK=8)` | ~100 tokens/entry | Session index entries: `session_id`, title, platform, project path, time, digest `one_liner`, `key_topics`, hit snippet |
| 2 | `vesti_timeline(session_id, around_turn?)` | ~30 tokens/turn | Turn outline of one session: seq, time, one-line user intent, tool-call count, tokens |
| 3 | `vesti_get_turns(session_id, turn_ids \| range, max_chars=8000)` | bounded by `max_chars` | Full user/assistant message text + tool-call summaries for the selected turns; sets `truncated: true` when the budget cuts output |

Recall is FTS5-based (over `messages_fts` + `sessions_fts`, RRF-fused — the same ranking as capture-core's `SessionRecall`). Digest embeddings are only fused when an embedding service supplies a query vector; the MCP server has none, so it degrades to pure FTS exactly as `SessionRecall` does without a vector.

## Requirements

- **Node ≥ 23.4** (uses the built-in `node:sqlite` module). On Node 22.x it also works if you pass `--experimental-sqlite` to node (see configs below).
- A VESTI database at `~/.vesti/db/vesti.db` (created by the VESTI desktop app or CLI capture). Override with the `VESTI_DB_PATH` environment variable.

The server opens the database **read-only** and never writes to it. Because it uses `node:sqlite` instead of better-sqlite3, it is immune to the Electron-vs-Node ABI mismatch of the desktop app's native module.

## Build

```bash
corepack pnpm install
corepack pnpm --filter @vesti/vesti-mcp build   # outputs dist/cli.js (+ dist/index.js)
corepack pnpm --filter @vesti/vesti-mcp test
```

## Register in your agent

Replace `<PKG>` with the absolute path to this package, e.g. `C:/Users/you/项目开发/VESTI-APP/packages/vesti-mcp`.

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

A `vesti` MCP server exposes my past AI-coding sessions. Use it when past
context may help (previous decisions, "how did we solve X", older errors):

1. `vesti_search` with a few keywords → session candidates (~100 tokens each).
2. `vesti_timeline` on the best session_id → turn outline; locate the passage.
3. `vesti_get_turns` with only the turn seq numbers you need → full content.

Never call vesti_get_turns without narrowing via search + timeline first; it
is the expensive layer and truncates at max_chars anyway. All data is local
and read-only.
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
      "score": 0.032254
    }
  ]
}
```

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

## Layout

- `src/db.ts` — db path resolution (`VESTI_DB_PATH` → `~/.vesti/db/vesti.db`) and read-only open
- `src/recall.ts` — FTS5 + RRF recall (port of capture-core `SessionRecall`, pure-FTS path)
- `src/tools.ts` — the three layer implementations
- `src/server.ts` — MCP wiring on the official `@modelcontextprotocol/sdk` (low-level `Server`, hand-written JSON Schemas, no zod)
- `src/cli.ts` — stdio entry (`bin: vesti-mcp`)
- `tests/` — vitest: tool contracts against a temp fixture db + protocol handshake over in-memory transports

When the database file is missing the CLI exits with guidance to run VESTI first; unknown sessions/tools are reported as MCP `isError` results.
