import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { AiderParser } from '../src/adapters/aider/parser.js';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code/adapter.js';
import { ClaudeCodeParser } from '../src/adapters/claude-code/parser.js';
import { CodexParser } from '../src/adapters/codex/parser.js';
import { CursorParser } from '../src/adapters/cursor/parser.js';
import { KimiCodeAdapter } from '../src/adapters/kimi-code/adapter.js';
import { KimiCodeParser } from '../src/adapters/kimi-code/parser.js';
import { MessageConverter } from '../src/storage/MessageConverter.js';

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

  it('strips environment_context from Codex titles but keeps the message record', async () => {
    const dir = await makeTempDir('vesti-codex-env-');
    const file = path.join(dir, 'rollout-22222222-2222-2222-2222-222222222222.jsonl');
    const rows = [
      { timestamp: '2026-07-15T01:00:00Z', type: 'session_meta', payload: { id: 'codex-env-session', cwd: 'C:/work/demo' } },
      { timestamp: '2026-07-15T01:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>C:\\work\\demo</cwd>\n  <shell>powershell</shell>\n</environment_context>' }] } },
      { timestamp: '2026-07-15T01:00:02Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '修复登录页的样式问题' }] } },
      { timestamp: '2026-07-15T01:00:03Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已修复' }] } },
    ];
    await fs.writeFile(file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);

    const session = await new CodexParser().parseFile(file);

    // Environment context stays in the message record (no data loss)…
    expect(session.messages.some(m => m.contentText?.includes('<environment_context>'))).toBe(true);
    // …but the first-prompt/title view skips it
    expect(session.meta?.first_prompt).toBe('修复登录页的样式问题');
    const converted = MessageConverter.convertV2(session);
    expect(converted.session.title).toBe('修复登录页的样式问题');
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
        tokenCount: 999_999,
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
      JSON.stringify({
        bubbleId: 'assistant-1',
        type: 2,
        text: 'fixed',
        thinking: 'checking',
        createdAt: 1_752_541_201_000,
        tokenCount: { inputTokens: 1_200, outputTokens: 80 },
        tokenCountUpUntilHere: 999_999,
      }),
    );
    db.close();

    const sessions = await new CursorParser().parseDatabase(file);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ sessionId: composerId, platform: 'cursor', model: 'cursor-test-model', projectPath: 'C:/work/cursor-demo' });
    expect(sessions[0].messages.map(message => message.contentText)).toEqual(['fix the test', 'fixed']);
    expect(sessions[0].messages[1].contentThinking).toBe('checking');
    expect(sessions[0].messages[1].usage).toMatchObject({
      inputTokens: 1_200,
      outputTokens: 80,
      model: 'cursor-test-model',
    });
    expect(sessions[0].tokenUsage).toMatchObject({
      totalInputTokens: 1_200,
      totalOutputTokens: 80,
    });
  });

  it('parses legacy Cursor inline conversations and their reported token usage', async () => {
    const dir = await makeTempDir('vesti-cursor-legacy-');
    const file = path.join(dir, 'state.vscdb');
    const composerId = 'legacy-composer-11111111';
    const db = new Database(file);
    db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)');
    db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(
      `composerData:${composerId}`,
      JSON.stringify({
        composerId,
        name: 'Legacy Cursor fixture',
        createdAt: 1_752_541_200_000,
        modelConfig: { modelName: 'cursor-legacy-model' },
        tokenCount: 888_888,
        conversation: [
          { bubbleId: 'legacy-user', type: 1, text: 'legacy question', tokenCount: { inputTokens: 0, outputTokens: 0 } },
          { bubbleId: 'legacy-assistant-1', type: 2, text: 'first answer', tokenCount: { inputTokens: 200, outputTokens: 30 } },
          { bubbleId: 'legacy-assistant-2', type: 2, text: 'second answer', tokenCount: { inputTokens: 350, outputTokens: 45 } },
        ],
      }),
    );
    db.close();

    const sessions = await new CursorParser().parseDatabase(file);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].messages.map(message => message.contentText)).toEqual([
      'legacy question',
      'first answer',
      'second answer',
    ]);
    expect(sessions[0].tokenUsage).toMatchObject({
      totalInputTokens: 550,
      totalOutputTokens: 75,
    });
    expect(MessageConverter.convertV2(sessions[0]).session).toMatchObject({
      totalInputTokens: 550,
      totalOutputTokens: 75,
    });
  });

  it('keeps legacy-envelope Kimi Code user, assistant and tool-result chains', async () => {
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

  it('parses Kimi Code protocol 1.4 wire events (desensitized from real wire.jsonl)', async () => {
    // Structure mirrors real protocol-1.4 events; all text is synthetic.
    const wire = [
      { type: 'metadata', protocol_version: '1.4', created_at: 1_784_370_940_249 },
      { type: 'config.update', profileName: 'agent', systemPrompt: 'You are a test CLI agent.', time: 1_784_370_940_249 },
      { type: 'tools.set_active_tools', names: ['Read', 'Bash'], time: 1_784_370_940_249 },
      // turn.prompt duplicates the following append_message — must not double-count
      { type: 'turn.prompt', input: [{ type: 'text', text: '整理一下这个仓库的结构' }], origin: { kind: 'user' }, time: 1_784_370_960_782 },
      { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: '整理一下这个仓库的结构' }], toolCalls: [], origin: { kind: 'user' } }, time: 1_784_370_960_783 },
      { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder> Plan mode is active.</system-reminder>' }], toolCalls: [], origin: { kind: 'injection' } }, time: 1_784_370_960_784 },
      { type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 'step-uuid-1', turnId: '0', step: 1 }, time: 1_784_370_960_786 },
      { type: 'llm.request', kind: 'loop', provider: 'kimi', model: 'k3', modelAlias: 'kimi-code/k3', time: 1_784_370_960_789 },
      { type: 'context.append_loop_event', event: { type: 'content.part', uuid: 'part-1', turnId: '0', step: 1, stepUuid: 'step-uuid-1', part: { type: 'think', think: '先列出仓库文件再总结。' } }, time: 1_784_370_960_790 },
      { type: 'context.append_loop_event', event: { type: 'content.part', uuid: 'part-2', turnId: '0', step: 1, stepUuid: 'step-uuid-1', part: { type: 'text', text: '我先查看仓库文件。' } }, time: 1_784_370_960_791 },
      { type: 'context.append_loop_event', event: { type: 'tool.call', uuid: 'tool_call_1', toolCallId: 'tool_call_1', turnId: '0', step: 1, stepUuid: 'step-uuid-1', name: 'Bash', args: { command: 'rg --files' }, description: 'List files' }, time: 1_784_370_960_792 },
      { type: 'context.append_loop_event', event: { type: 'tool.result', parentUuid: 'tool_call_1', toolCallId: 'tool_call_1', result: { output: 'README.md\nsrc/index.ts' } }, time: 1_784_370_960_800 },
      // step.end usage duplicates usage.record (turn scope) — must not double-count
      { type: 'context.append_loop_event', event: { type: 'step.end', uuid: 'step-uuid-1', turnId: '0', step: 1, usage: { inputOther: 100, output: 20, inputCacheRead: 40, inputCacheCreation: 0 }, finishReason: 'tool_use' }, time: 1_784_370_960_801 },
      { type: 'usage.record', model: 'kimi-code/k3', usage: { inputOther: 100, output: 20, inputCacheRead: 40, inputCacheCreation: 0 }, usageScope: 'turn', time: 1_784_370_960_802 },
    ];

    const session = new KimiCodeParser().parseWireContent(
      `${wire.map(row => JSON.stringify(row)).join('\n')}\n`,
      { sessionId: 'session-fixture', projectPath: 'C:/work/demo', agentName: 'main' },
    );

    expect(session.platform).toBe('kimi-code');
    // user prompt + injection + think + text + tool call + tool result
    expect(session.messages.map(m => [m.role, m.type])).toEqual([
      ['user', 'user'],
      ['system', 'system'],
      ['assistant', 'assistant'],
      ['assistant', 'assistant'],
      ['assistant', 'assistant'],
      ['user', 'user'],
    ]);
    expect(session.messages[0].contentText).toBe('整理一下这个仓库的结构');
    expect(session.messages[2].contentThinking).toContain('先列出仓库文件');
    expect(session.messages[4].toolCalls?.[0]).toMatchObject({ name: 'Bash' });
    expect(session.messages[5].isToolResult).toBe(true);
    expect(session.toolExecutions[0]).toMatchObject({ toolName: 'Bash' });
    expect(session.toolExecutions[0].outputSummary).toContain('README.md');
    expect(session.model).toBe('kimi-code/k3');
    // usage.record only — step.end must not double the totals
    expect(session.tokenUsage).toMatchObject({
      totalInputTokens: 140,
      totalOutputTokens: 20,
      totalCacheReadTokens: 40,
    });
    expect(session.warnings).toBeUndefined();
    expect(session.meta?.protocol_version).toBe('1.4');

    const converted = MessageConverter.convertV2(session);
    expect(converted.session.title).toBe('整理一下这个仓库的结构');
  });

  it('warns instead of failing silently on unrecognized Kimi wire protocols', async () => {
    const wire = [
      { type: 'metadata', protocol_version: '9.9', created_at: 1 },
      { type: 'future.event', foo: 1, time: 2 },
      { type: 'future.other', bar: 2, time: 3 },
      { type: 'future.event', foo: 3, time: 4 },
      { type: 'future.third', baz: 5, time: 6 },
    ];

    const session = new KimiCodeParser().parseWireContent(
      `${wire.map(row => JSON.stringify(row)).join('\n')}\n`,
      { sessionId: 'session-future', projectPath: '' },
    );

    expect(session.messages).toHaveLength(0);
    expect(session.warnings?.some(w => w.includes('unrecognized'))).toBe(true);
    expect(session.warnings?.some(w => w.includes('0 messages'))).toBe(true);
  });

  it('discovers Kimi Code sessions in the real sessions/<wd>/<session>/agents layout', async () => {
    const home = await makeTempDir('vesti-kimi-home-');
    const sessionDir = path.join(home, '.kimi-code', 'sessions', 'wd_demo_0123456789ab', 'session_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    const mainDir = path.join(sessionDir, 'agents', 'main');
    const subDir = path.join(sessionDir, 'agents', 'agent-0');
    await fs.ensureDir(mainDir);
    await fs.ensureDir(subDir);
    await fs.writeJSON(path.join(sessionDir, 'state.json'), {
      createdAt: '2026-07-18T09:00:00.000Z',
      updatedAt: '2026-07-18T09:05:00.000Z',
      title: 'New Session',
      isCustomTitle: false,
      agents: {
        main: { type: 'main', parentAgentId: null },
        'agent-0': { type: 'sub', parentAgentId: 'main', swarmItem: '调研员' },
      },
      workDir: 'C:/work/kimi-demo',
    });
    const mainWire = [
      { type: 'metadata', protocol_version: '1.4', created_at: 1_784_370_940_249 },
      { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: '写一个演示脚本' }], toolCalls: [], origin: { kind: 'user' } }, time: 1_784_370_960_783 },
      { type: 'context.append_loop_event', event: { type: 'content.part', uuid: 'p1', turnId: '0', step: 1, part: { type: 'text', text: '好的。' } }, time: 1_784_370_960_790 },
    ];
    const subWire = [
      { type: 'metadata', protocol_version: '1.4', created_at: 1_784_370_940_300 },
      { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: '<git-context status="unavailable" reason="not-a-repo"/>\n\n调研竞争对手' }], toolCalls: [], origin: { kind: 'system_trigger', name: 'subagent' } }, time: 1_784_370_960_900 },
      { type: 'context.append_loop_event', event: { type: 'content.part', uuid: 'p2', turnId: '0', step: 1, part: { type: 'text', text: '调研结果。' } }, time: 1_784_370_961_000 },
    ];
    await fs.writeFile(path.join(mainDir, 'wire.jsonl'), `${mainWire.map(r => JSON.stringify(r)).join('\n')}\n`);
    await fs.writeFile(path.join(subDir, 'wire.jsonl'), `${subWire.map(r => JSON.stringify(r)).join('\n')}\n`);

    const adapter = new KimiCodeAdapter();
    adapter.setHomeRoots([{ host: 'native', homeDir: home }]);

    const detected = await adapter.detect();
    expect(detected.installed).toBe(true);

    const files = await adapter.getSessionFiles();
    expect(files).toHaveLength(2);

    const main = await adapter.parseSession(path.join(mainDir, 'wire.jsonl'));
    expect(main.sessionId).toBe('session_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(main.projectPath).toBe('C:/work/kimi-demo');
    expect(main.messages.length).toBeGreaterThan(0);
    expect(main.subagents).toHaveLength(1);
    expect(main.subagents[0]).toMatchObject({ agentId: 'agent-0', slug: '调研员' });

    const sub = await adapter.parseSession(path.join(subDir, 'wire.jsonl'));
    expect(sub.sessionId).toBe('session_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee--agent-0');
    expect(sub.projectPath).toBe('C:/work/kimi-demo');
    expect(sub.messages.length).toBeGreaterThan(0);
    // git-context injection is stripped from the title chain
    const converted = MessageConverter.convertV2(sub);
    expect(converted.session.title).toBe('调研竞争对手');
  });

  const realKimiSessions = path.join(os.homedir(), '.kimi-code', 'sessions');
  it.skipIf(!fs.existsSync(realKimiSessions))(
    'smoke: detects and parses the real ~/.kimi-code main wire with messages',
    async () => {
      const adapter = new KimiCodeAdapter();
      const detected = await adapter.detect();
      expect(detected.installed).toBe(true);
      expect(detected.sessionCount ?? 0).toBeGreaterThan(0);

      const files = await adapter.getSessionFiles();
      const mainWire = files.find(f => f.includes(`${path.sep}main${path.sep}`));
      expect(mainWire).toBeDefined();

      const session = await adapter.parseSession(mainWire!);
      expect(session.messages.length).toBeGreaterThan(0);
      expect(session.warnings ?? []).toEqual([]);
      expect(session.projectPath).not.toBe('');
    },
  );

  it('parses Claude Code user, assistant, tool chains and token usage', async () => {
    const dir = await makeTempDir('vesti-claude-');
    // The parser derives the sessionId from the file name.
    const file = path.join(dir, 'claude-session.jsonl');
    const rows = [
      { type: 'user', uuid: 'u1', timestamp: '2026-07-15T01:00:00Z', cwd: 'C:/work/demo', gitBranch: 'main', version: '1.0.0', sessionId: 'claude-session', message: { role: 'user', content: 'inspect this repo' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-07-15T01:00:01Z', cwd: 'C:/work/demo', sessionId: 'claude-session', message: { role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'looking' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }], usage: { input_tokens: 10, output_tokens: 4, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 } } },
      { type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: '2026-07-15T01:00:02Z', sessionId: 'claude-session', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'README.md' }] } },
      { type: 'assistant', uuid: 'a2', parentUuid: 'u2', timestamp: '2026-07-15T01:00:03Z', sessionId: 'claude-session', message: { role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'done' }] } },
    ];
    await fs.writeFile(file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);

    const session = await new ClaudeCodeParser().parseFile(file);

    expect(session.sessionId).toBe('claude-session');
    expect(session.platform).toBe('claude-code');
    expect(session.projectPath).toBe('C:/work/demo');
    expect(session.gitBranch).toBe('main');
    expect(session.model).toBe('claude-test');
    expect(session.messages).toHaveLength(4);
    expect(session.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    // The tool_result user message is classified as tool output, not user input
    expect(session.messages[2].isToolResult).toBe(true);
    expect(session.toolExecutions[0]).toMatchObject({ toolName: 'Bash', outputSummary: 'README.md' });
    expect(session.tokenUsage).toMatchObject({ totalInputTokens: 10, totalOutputTokens: 4, totalCacheCreationTokens: 1, totalCacheReadTokens: 2 });
  });

  it('enumerates Claude Code subagent transcripts so links can resolve', async () => {
    const home = await makeTempDir('vesti-claude-home-');
    const projectDir = path.join(home, '.claude', 'projects', 'demo');
    const subagentsDir = path.join(projectDir, 'claude-session', 'subagents');
    await fs.ensureDir(subagentsDir);
    const sessionFile = path.join(projectDir, 'claude-session.jsonl');
    await fs.writeFile(sessionFile, `${JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-07-15T01:00:00Z', cwd: 'C:/work/demo', sessionId: 'claude-session', message: { role: 'user', content: '主会话输入内容' } })}\n`);
    await fs.writeFile(
      path.join(subagentsDir, 'agent-abc123.jsonl'),
      `${JSON.stringify({ type: 'user', uuid: 'u2', timestamp: '2026-07-15T01:00:01Z', cwd: 'C:/work/demo', sessionId: 'claude-session', agentId: 'abc123', message: { role: 'user', content: '子代理任务内容' } })}\n`,
    );

    const adapter = new ClaudeCodeAdapter();
    adapter.setHomeRoots([{ host: 'native', homeDir: home }]);

    // Enumeration no longer excludes **/subagents/**
    const files = await adapter.getSessionFiles();
    expect(files.some(f => f.includes('agent-abc123.jsonl'))).toBe(true);

    // The main session still advertises the subagent ref for linking
    const main = await adapter.parseSession(sessionFile);
    expect(main.subagents.map(s => s.agentId)).toContain('abc123');

    // The subagent transcript parses as a standalone session
    const subFile = files.find(f => f.includes('agent-abc123.jsonl'))!;
    const sub = await adapter.parseSession(subFile);
    expect(sub.messages.length).toBeGreaterThan(0);
  });

  it('parses aider markdown history into sessions with user/assistant messages', async () => {
    const dir = await makeTempDir('vesti-aider-');
    const file = path.join(dir, '.aider.chat.history.md');
    await fs.writeFile(file, [
      '# aider chat started at 2026-07-15 01:00:00',
      '',
      '> meta output line, skipped',
      '#### USER',
      'add a hello route',
      '',
      '#### ASSISTANT',
      'Added the route to app.py.',
      '',
      '# aider chat started at 2026-07-15 02:00:00',
      '',
      '#### USER',
      'remove it again',
      '',
      '#### ASSISTANT',
      'Reverted.',
      '',
    ].join('\n'));

    const sessions = await new AiderParser().parseFile(file);

    expect(sessions).toHaveLength(2);
    expect(sessions[0].platform).toBe('aider');
    expect(sessions[0].sessionId).toBe(`chat-${Date.parse('2026-07-15 01:00:00')}`);
    expect(sessions[0].messages.map(message => [message.role, message.contentText])).toEqual([
      ['user', 'add a hello route'],
      ['assistant', 'Added the route to app.py.'],
    ]);
    expect(sessions[0].startTime).toBe(Date.parse('2026-07-15 01:00:00'));
    expect(sessions[1].messages.map(message => message.contentText)).toEqual(['remove it again', 'Reverted.']);
  });
});
