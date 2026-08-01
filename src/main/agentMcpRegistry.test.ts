import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentMcpRegistry,
  defaultServerEntryCandidates,
  resolveAgentMcpTargetId,
  resolveServerEntry,
} from './agentMcpRegistry';

let home: string;
let serverEntry: string;
let registry: AgentMcpRegistry;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'vesti-mcp-registry-'));
  // A fake built server entry so registration has something to point at.
  serverEntry = path.join(home, 'repo', 'packages', 'vesti-mcp', 'dist', 'cli.js');
  fs.mkdirSync(path.dirname(serverEntry), { recursive: true });
  fs.writeFileSync(serverEntry, '// fake vesti-mcp entry\n', 'utf8');
  registry = new AgentMcpRegistry({ homeDir: home, serverEntry });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const kimiConfig = () => path.join(home, '.kimi-code', 'mcp.json');
const claudeConfig = () => path.join(home, '.claude.json');
const codexConfig = () => path.join(home, '.codex', 'config.toml');
const cursorConfig = () => path.join(home, '.cursor', 'mcp.json');

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

describe('target detection and status', () => {
  it('reports every agent as undetected on an empty home', () => {
    const status = registry.listStatus();
    expect(status.map(s => s.id)).toEqual(['kimi-code', 'claude-code', 'codex', 'cursor']);
    for (const entry of status) {
      expect(entry.detected).toBe(false);
      expect(entry.registered).toBe(false);
      expect(entry.upToDate).toBe(false);
      expect(entry.serverAvailable).toBe(true);
      expect(entry.serverEntry).toBe(serverEntry.replace(/\\/g, '/'));
    }
  });

  it('detects agents by their config dir/file', () => {
    fs.mkdirSync(path.join(home, '.kimi-code'), { recursive: true });
    fs.writeFileSync(claudeConfig(), '{}', 'utf8');
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    const byId = new Map(registry.listStatus().map(s => [s.id, s]));
    expect(byId.get('kimi-code')!.detected).toBe(true);
    expect(byId.get('claude-code')!.detected).toBe(true);
    expect(byId.get('codex')!.detected).toBe(false);
    expect(byId.get('cursor')!.detected).toBe(true);
  });

  it('surfaces malformed JSON as a status error instead of throwing', () => {
    fs.writeFileSync(claudeConfig(), '{ not json', 'utf8');
    const status = registry.listStatus().find(s => s.id === 'claude-code')!;
    expect(status.error).toMatch(/not valid JSON/);
    expect(status.registered).toBe(false);
  });

  it('validates target ids', () => {
    expect(resolveAgentMcpTargetId('kimi-code')).toBe('kimi-code');
    expect(resolveAgentMcpTargetId('nope')).toBeNull();
    expect(resolveAgentMcpTargetId(undefined)).toBeNull();
  });
});

describe('JSON targets (kimi-code / claude-code / cursor)', () => {
  it('creates the config file when registering on a fresh home', () => {
    const result = registry.register('kimi-code');
    expect(result).toMatchObject({ ok: true, changed: true, backupPath: null });
    const config = readJson(kimiConfig());
    expect(config.mcpServers).toEqual({
      vesti: { command: 'node', args: [serverEntry.replace(/\\/g, '/')] },
    });
    expect(registry.listStatus().find(s => s.id === 'kimi-code')).toMatchObject({
      registered: true,
      upToDate: true,
    });
  });

  it('merges into an existing config without touching other servers or keys', () => {
    fs.writeFileSync(claudeConfig(), JSON.stringify({
      numStartups: 7,
      mcpServers: { other: { command: 'other-bin', args: ['--flag'] } },
    }), 'utf8');

    const result = registry.register('claude-code');
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.backupPath).not.toBeNull();
    expect(fs.existsSync(result.backupPath!)).toBe(true);
    // The backup holds the pre-write content.
    expect(readJson(result.backupPath!)).toEqual({
      numStartups: 7,
      mcpServers: { other: { command: 'other-bin', args: ['--flag'] } },
    });

    const config = readJson(claudeConfig());
    expect(config.numStartups).toBe(7);
    expect((config.mcpServers as Record<string, unknown>).other).toEqual({ command: 'other-bin', args: ['--flag'] });
    expect((config.mcpServers as Record<string, unknown>).vesti).toEqual({
      command: 'node',
      args: [serverEntry.replace(/\\/g, '/')],
    });
  });

  it('is idempotent: a second register changes nothing and writes no backup', () => {
    expect(registry.register('cursor').changed).toBe(true);
    const second = registry.register('cursor');
    expect(second).toMatchObject({ ok: true, changed: false, backupPath: null });
    // Exactly one mcp.json on disk, no stray backups.
    expect(fs.readdirSync(path.join(home, '.cursor'))).toEqual(['mcp.json']);
  });

  it('unregister removes only the vesti entry and is itself idempotent', () => {
    registry.register('cursor');
    const config = readJson(cursorConfig());
    (config.mcpServers as Record<string, unknown>).mine = { command: 'mine' };
    fs.writeFileSync(cursorConfig(), JSON.stringify(config), 'utf8');

    const removed = registry.unregister('cursor');
    expect(removed).toMatchObject({ ok: true, changed: true });
    const after = readJson(cursorConfig());
    expect(after.mcpServers).toEqual({ mine: { command: 'mine' } });
    expect(registry.unregister('cursor')).toMatchObject({ ok: true, changed: false });
    expect(registry.listStatus().find(s => s.id === 'cursor')!.registered).toBe(false);
  });

  it('refuses to clobber malformed JSON and reports the error', () => {
    fs.mkdirSync(path.join(home, '.kimi-code'), { recursive: true });
    fs.writeFileSync(kimiConfig(), '[1,2]', 'utf8');
    const result = registry.register('kimi-code');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(fs.readFileSync(kimiConfig(), 'utf8')).toBe('[1,2]');
  });

  it('flags an outdated vesti entry as registered but not up-to-date', () => {
    fs.mkdirSync(path.join(home, '.kimi-code'), { recursive: true });
    fs.writeFileSync(kimiConfig(), JSON.stringify({
      mcpServers: { vesti: { command: 'node', args: ['C:/old/path/cli.js'] } },
    }), 'utf8');
    const status = registry.listStatus().find(s => s.id === 'kimi-code')!;
    expect(status.registered).toBe(true);
    expect(status.upToDate).toBe(false);
    // Re-registering repairs it.
    expect(registry.register('kimi-code').changed).toBe(true);
    expect(registry.listStatus().find(s => s.id === 'kimi-code')!.upToDate).toBe(true);
  });
});

describe('codex TOML target', () => {
  const EXISTING = [
    'model = "gpt-5"',
    '',
    '[mcp_servers]',
    '',
    '[mcp_servers.node_repl]',
    'command = "C:/runtimes/node_repl.exe"',
    'args = []',
    '',
    '[mcp_servers.node_repl.env]',
    'CODEX_HOME = "C:/Users/me/.codex"',
    '',
  ].join('\n');

  it('appends the vesti section without touching existing mcp servers', () => {
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(codexConfig(), EXISTING, 'utf8');

    const result = registry.register('codex');
    expect(result).toMatchObject({ ok: true, changed: true });
    expect(result.backupPath).not.toBeNull();

    const content = fs.readFileSync(codexConfig(), 'utf8');
    expect(content).toContain(EXISTING.trim());
    expect(content).toContain('[mcp_servers.vesti]');
    expect(content).toContain(`args = ["${serverEntry.replace(/\\/g, '/')}"]`);
    // Existing sections survive verbatim.
    expect(content).toContain('[mcp_servers.node_repl.env]');
    expect(registry.listStatus().find(s => s.id === 'codex')).toMatchObject({
      registered: true,
      upToDate: true,
    });
  });

  it('replaces a stale vesti section in place (idempotent afterwards)', () => {
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(codexConfig(), `${EXISTING}[mcp_servers.vesti]\ncommand = "node"\nargs = ["C:/old/cli.js"]\n`, 'utf8');

    expect(registry.register('codex').changed).toBe(true);
    const content = fs.readFileSync(codexConfig(), 'utf8');
    expect(content).not.toContain('C:/old/cli.js');
    expect(content.match(/\[mcp_servers\.vesti\]/g)).toHaveLength(1);

    const second = registry.register('codex');
    expect(second).toMatchObject({ ok: true, changed: false, backupPath: null });
  });

  it('unregister removes only the vesti section, keeping neighbours intact', () => {
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    registry.register('codex');
    const withBoth = fs.readFileSync(codexConfig(), 'utf8') +
      '\n[mcp_servers.node_repl]\ncommand = "x"\nargs = []\n';
    fs.writeFileSync(codexConfig(), withBoth, 'utf8');

    expect(registry.unregister('codex')).toMatchObject({ ok: true, changed: true });
    const content = fs.readFileSync(codexConfig(), 'utf8');
    expect(content).not.toContain('[mcp_servers.vesti]');
    expect(content).toContain('[mcp_servers.node_repl]');
    expect(registry.listStatus().find(s => s.id === 'codex')!.registered).toBe(false);
    expect(registry.unregister('codex')).toMatchObject({ ok: true, changed: false });
  });
});

describe('server entry resolution', () => {
  it('refuses registration when the server entry is missing', () => {
    const broken = new AgentMcpRegistry({ homeDir: home, serverEntry: null });
    const result = broken.register('kimi-code');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/pnpm mcp:build/);
    expect(fs.existsSync(kimiConfig())).toBe(false);
    expect(broken.listStatus()[0].serverAvailable).toBe(false);
  });

  it('picks the first existing candidate and honors the env override', () => {
    const dev = path.join(home, 'app', 'packages', 'vesti-mcp', 'dist', 'cli.js');
    fs.mkdirSync(path.dirname(dev), { recursive: true });
    fs.writeFileSync(dev, '// dev build', 'utf8');
    const candidates = defaultServerEntryCandidates(path.join(home, 'app'), path.join(home, 'res'), {});
    expect(resolveServerEntry(candidates)).toBe(dev);
    const withOverride = defaultServerEntryCandidates(path.join(home, 'app'), path.join(home, 'res'), {
      VESTI_MCP_SERVER_PATH: serverEntry,
    });
    expect(withOverride[0]).toBe(serverEntry);
    expect(resolveServerEntry(withOverride)).toBe(serverEntry);
    expect(resolveServerEntry([path.join(home, 'nothing-here.js')])).toBeNull();
  });
});
