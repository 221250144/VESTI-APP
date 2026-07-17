import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexParser } from '../src/adapters/codex/parser.js';
import { CursorParser } from '../src/adapters/cursor/parser.js';
import { KimiCodeParser } from '../src/adapters/kimi-code/parser.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.remove(dir)));
});

describe('capture adapters', () => {
  it('parses current Codex rollout messages, tools and token totals', async () => {
    const dir = await makeTempDir('vesti-codex-');
    const file = path.join(dir, 'rollout-11111111-1111-1111-1111-111111111111.jsonl');
    const rows = [
      { timestamp: '2026-07-15T01:00:00Z', type: 'session_meta', payload: { id: 'codex-session', cwd: 'C:/work/demo', cli_version: '1.0.0' } },
      { timestamp: '2026-07-15T01:00:01Z', type: 'turn_context', payload: { cwd: 'C:/work/demo', model: 'gpt-test' } },
      { timestamp: '2026-07-15T01:00:02Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'inspect this repo' }] } },
      { timestamp: '2026-07-15T01:00:03Z', type: 'response_item', payload: { type: 'function_call', call_id: 'call-1', name: 'shell_command', arguments: '{"command":"rg --files"}' } },
      { timestamp: '2026-07-15T01:00:04Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'README.md' } },
      { timestamp: '2026-07-15T01:00:05Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } },
      { timestamp: '2026-07-15T01:00:06Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 21, cached_input_tokens: 8, output_tokens: 5 } } } },
    ];
    await fs.writeFile(file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);

    const session = await new CodexParser().parseFile(file);

    expect(session.sessionId).toBe('codex-session');
    expect(session.platform).toBe('codex');
    expect(session.model).toBe('gpt-test');
    expect(session.messages).toHaveLength(4);
    expect(session.toolExecutions[0]).toMatchObject({ toolName: 'shell_command', outputSummary: 'README.md' });
    expect(session.tokenUsage).toMatchObject({ totalInputTokens: 21, totalOutputTokens: 5, totalCacheReadTokens: 8 });
  });

  it('parses Cursor composer data from its SQLite key-value chain', async () => {
    const dir = await makeTempDir('vesti-cursor-');
    const file = path.join(dir, 'state.vscdb');
    const composerId = 'composer-11111111';
    const db = new Database(file);
    db.exec(`
      CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB);
      CREATE TABLE composerHeaders (
        composerId TEXT PRIMARY KEY,
        createdAt INTEGER,
        lastUpdatedAt INTEGER,
        isArchived INTEGER,
        isSubagent INTEGER,
        value BLOB
      );
    `);
    db.prepare('INSERT INTO composerHeaders VALUES (?, ?, ?, ?, ?, ?)').run(
      composerId,
      1_752_541_200_000,
      1_752_541_202_000,
      0,
      0,
      JSON.stringify({ composerId, name: 'Cursor fixture', workspaceIdentifier: { fsPath: 'C:/work/cursor-demo' } }),
    );
    db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(
      `composerData:${composerId}`,
      JSON.stringify({
        composerId,
        name: 'Cursor fixture',
        modelConfig: { modelName: 'cursor-test-model' },
        fullConversationHeadersOnly: [
          { bubbleId: 'user-1', type: 1, createdAt: 1_752_541_200_000 },
          { bubbleId: 'assistant-1', type: 2, createdAt: 1_752_541_201_000 },
        ],
      }),
    );
    db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(
      `bubbleId:${composerId}:user-1`,
      JSON.stringify({ bubbleId: 'user-1', type: 1, text: 'fix the test', createdAt: 1_752_541_200_000 }),
    );
    db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(
      `bubbleId:${composerId}:assistant-1`,
      JSON.stringify({ bubbleId: 'assistant-1', type: 2, text: 'fixed', thinking: 'checking', createdAt: 1_752_541_201_000 }),
    );
    db.close();

    const sessions = await new CursorParser().parseDatabase(file);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ sessionId: composerId, platform: 'cursor', model: 'cursor-test-model', projectPath: 'C:/work/cursor-demo' });
    expect(sessions[0].messages.map(message => message.contentText)).toEqual(['fix the test', 'fixed']);
    expect(sessions[0].messages[1].contentThinking).toBe('checking');
  });

  it('keeps Kimi Code user, assistant and tool-result chains', async () => {
    const root = await makeTempDir('vesti-kimi-');
    const sessionDir = path.join(root, 'project-hash', 'kimi-session');
    await fs.ensureDir(sessionDir);
    const wire = [
      { timestamp: 1_752_541_200, message: { type: 'TurnBegin', payload: { user_input: 'scan files' } } },
      { timestamp: 1_752_541_201, message: { type: 'ContentPart', payload: { type: 'text', text: 'working' } } },
      { timestamp: 1_752_541_202, message: { type: 'ToolCall', payload: { id: 'kimi-call', function: { name: 'Shell', arguments: 'rg --files' } } } },
      { timestamp: 1_752_541_203, message: { type: 'ToolResult', payload: { tool_call_id: 'kimi-call', return_value: { is_error: false, output: 'README.md' } } } },
    ];
    await fs.writeFile(path.join(sessionDir, 'wire.jsonl'), `${wire.map(row => JSON.stringify(row)).join('\n')}\n`);

    const session = await new KimiCodeParser().parseSessionDir(sessionDir);

    expect(session.platform).toBe('kimi-code');
    expect(session.messages).toHaveLength(4);
    expect(session.toolExecutions[0]).toMatchObject({ toolName: 'Shell', outputSummary: 'README.md' });
  });
});
