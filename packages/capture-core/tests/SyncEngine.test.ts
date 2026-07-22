/**
 * SyncEngine subagent-link resolution.
 *
 * Link rows are written when the parent session syncs; the child side only
 * resolves against sync_state. These tests cover the two paths every sync
 * route depends on:
 *   1. resolveSubagentLinks() resolves from sync_state after both files
 *      synced (the syncAll path);
 *   2. a transcript that exists on disk but was never synced is synced
 *      on demand inside resolveSubagentLinks(), so watch/poll routes that
 *      only saw the parent file still mount the subagent.
 */

import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';
import { AdapterManager } from '../src/adapters/AdapterManager.js';
import { DatabaseManager } from '../src/storage/DatabaseManager.js';
import { SyncEngine } from '../src/sync/SyncEngine.js';
import type { AgentAdapter, AgentDetectResult, ParsedSession } from '../src/types/agent.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.remove(dir)));
});

/** Minimal fixture adapter: each file is a JSON-serialized ParsedSession. */
class FixtureAdapter implements AgentAdapter {
  readonly platform = 'claude-code' as const;
  readonly name = 'Fixture';
  parserVersion = 0;
  parseCount = 0;
  constructor(private dir: string) {}
  async detect(): Promise<AgentDetectResult> {
    return { installed: true };
  }
  async parseSession(filePath: string): Promise<ParsedSession> {
    this.parseCount++;
    const raw = await fs.readJSON(filePath) as ParsedSession;
    raw.tokenUsage = { ...raw.tokenUsage, models: new Set() };
    return raw;
  }
  async getSessionFiles(): Promise<string[]> {
    const entries = await fs.readdir(this.dir);
    return entries.filter(name => name.endsWith('.json')).map(name => path.join(this.dir, name));
  }
  getWatchPatterns(): string[] {
    return [];
  }
}

function fixtureSession(sessionId: string, overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    sessionId,
    platform: 'claude-code',
    projectPath: 'C:/work/demo',
    messages: [{
      uuid: `${sessionId}-m1`,
      type: 'user',
      role: 'user',
      timestamp: 1000,
      contentText: `hello from ${sessionId}`,
      isToolResult: false,
      depth: 0,
    }],
    toolExecutions: [],
    subagents: [],
    tokenUsage: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      models: new Set(),
    },
    startTime: 1000,
    endTime: 2000,
    ...overrides,
  };
}

async function setup() {
  const dir = await makeTempDir('vesti-syncengine-');
  const sessionsDir = path.join(dir, 'sessions');
  await fs.ensureDir(sessionsDir);
  const db = new DatabaseManager(path.join(dir, 'vesti.db'));
  await db.initialize();
  const adapters = new AdapterManager();
  const adapter = new FixtureAdapter(sessionsDir);
  adapters.register(adapter);
  const engine = new SyncEngine(adapters, db);
  return { sessionsDir, db, engine, adapter };
}

describe('SyncEngine.resolveSubagentLinks', () => {
  it('resolves links from sync_state once parent and child are synced', async () => {
    const { sessionsDir, db, engine } = await setup();
    const childPath = path.join(sessionsDir, 'child.json');
    await fs.writeJSON(childPath, fixtureSession('agent-a1'));
    const parentPath = path.join(sessionsDir, 'parent.json');
    await fs.writeJSON(
      parentPath,
      fixtureSession('parent-1', { subagents: [{ agentId: 'a1', filePath: childPath }] }),
    );

    // syncAll shape without touching the other adapters' real home dirs.
    await engine.syncPlatform('claude-code', [parentPath, childPath]);
    await engine.resolveSubagentLinks();

    const links = db.getSubagentLinks('claude-code:parent-1');
    expect(links).toHaveLength(1);
    expect(links[0].childSessionId).toBe('claude-code:agent-a1');
    expect(db.getUnresolvedSubagentLinks()).toHaveLength(0);
    await db.close();
  });

  it('syncs a never-synced transcript on demand and then resolves it', async () => {
    const { sessionsDir, db, engine } = await setup();
    const childPath = path.join(sessionsDir, 'child.json');
    await fs.writeJSON(childPath, fixtureSession('agent-a2'));
    const parentPath = path.join(sessionsDir, 'parent.json');
    await fs.writeJSON(
      parentPath,
      fixtureSession('parent-2', { subagents: [{ agentId: 'a2', filePath: childPath }] }),
    );

    // Watch-route shape: only the parent file event was seen.
    await engine.syncFile('claude-code', parentPath);
    expect(db.getUnresolvedSubagentLinks()).toHaveLength(1);
    expect(db.getWorkSession('claude-code:agent-a2')).toBeNull();

    const resolved = await engine.resolveSubagentLinks();

    expect(resolved).toBe(1);
    expect(db.getWorkSession('claude-code:agent-a2')).not.toBeNull();
    expect(db.getSubagentLinks('claude-code:parent-2')[0].childSessionId).toBe('claude-code:agent-a2');
    await db.close();
  });

  it('leaves links whose transcript is gone unresolved without failing', async () => {
    const { sessionsDir, db, engine } = await setup();
    const missingPath = path.join(sessionsDir, 'deleted-child.json');
    const parentPath = path.join(sessionsDir, 'parent.json');
    await fs.writeJSON(
      parentPath,
      fixtureSession('parent-3', { subagents: [{ agentId: 'a3', filePath: missingPath }] }),
    );

    await engine.syncPlatform('claude-code', [parentPath]);
    await engine.resolveSubagentLinks();

    expect(db.getUnresolvedSubagentLinks()).toHaveLength(1);
    await db.close();
  });
});

describe('SyncEngine parser-version re-parse', () => {
  it('re-parses an unchanged file after the adapter parserVersion bumps', async () => {
    const { sessionsDir, db, engine, adapter } = await setup();
    const filePath = path.join(sessionsDir, 'session.json');
    await fs.writeJSON(filePath, fixtureSession('reparse-1'));

    await engine.syncFile('claude-code', filePath);
    expect(adapter.parseCount).toBe(1);

    // Unchanged file + same parser: the size/mtime short-circuit holds.
    expect(await engine.syncFile('claude-code', filePath)).toBeNull();
    expect(adapter.parseCount).toBe(1);

    // Parser upgrade: the same bytes must be parsed again (new extraction),
    // and the stored version advances so it only happens once.
    adapter.parserVersion = 2;
    expect(await engine.syncFile('claude-code', filePath)).not.toBeNull();
    expect(adapter.parseCount).toBe(2);
    expect(db.getSyncState(filePath)?.parserVersion).toBe(2);
    expect(await engine.syncFile('claude-code', filePath)).toBeNull();
    expect(adapter.parseCount).toBe(2);
    await db.close();
  });
});
