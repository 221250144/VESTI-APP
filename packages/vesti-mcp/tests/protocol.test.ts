/**
 * Minimal protocol handshake test: initialize + tools/list + tools/call over
 * the SDK's linked in-memory transports (the same Server instance the stdio
 * CLI serves).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openVestiDb, type VestiDatabase } from '../src/db.js';
import { createVestiMcpServer } from '../src/server.js';
import { createFixtureDb, SESSION_A, type Fixture } from './helpers/fixture.js';

let fixture: Fixture;
let db: VestiDatabase;
let client: Client;

beforeEach(async () => {
  fixture = createFixtureDb();
  db = openVestiDb(fixture.dbPath);
  const server = createVestiMcpServer(db);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  db.close();
  fixture.cleanup();
});

describe('MCP handshake', () => {
  it('completes initialize and reports the server identity', () => {
    const info = client.getServerVersion();
    expect(info?.name).toBe('vesti-mcp');
    expect(client.getServerCapabilities()?.tools).toBeDefined();
  });

  it('lists the three progressive-disclosure tools plus the project-brief tool', async () => {
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).toEqual(['vesti_search', 'vesti_timeline', 'vesti_get_turns', 'vesti_project_brief']);
    for (const tool of tools.slice(0, 3)) {
      expect(tool.description).toMatch(/Layer [123] of 3/);
      expect(tool.inputSchema.type).toBe('object');
    }
    expect(tools[0].inputSchema.required).toContain('query');
    expect(tools[1].inputSchema.required).toContain('session_id');
    expect(tools[2].inputSchema.required).toContain('session_id');
    expect(tools[3].inputSchema.required).toContain('project');
  });

  it('serves vesti_search → vesti_timeline → vesti_get_turns end to end', async () => {
    const search = await client.callTool({ name: 'vesti_search', arguments: { query: 'transactional migrations' } });
    expect(search.isError).toBeFalsy();
    const searchPayload = JSON.parse((search.content as Array<{ text: string }>)[0].text);
    const sessionId = searchPayload.results[0].session_id;
    expect(sessionId).toBe(SESSION_A);

    const timeline = await client.callTool({ name: 'vesti_timeline', arguments: { session_id: sessionId } });
    const timelinePayload = JSON.parse((timeline.content as Array<{ text: string }>)[0].text);
    expect(timelinePayload.total_turns).toBe(3);

    const turns = await client.callTool({
      name: 'vesti_get_turns',
      arguments: { session_id: sessionId, turn_ids: [1] },
    });
    const turnsPayload = JSON.parse((turns.content as Array<{ text: string }>)[0].text);
    expect(turnsPayload.turns[0].assistant).toContain('transaction');
  });

  it('returns isError for unknown tools and unknown sessions', async () => {
    const unknownTool = await client.callTool({ name: 'vesti_nope', arguments: {} });
    expect(unknownTool.isError).toBe(true);

    const unknownSession = await client.callTool({
      name: 'vesti_timeline',
      arguments: { session_id: 'nope' },
    });
    expect(unknownSession.isError).toBe(true);
    expect((unknownSession.content as Array<{ text: string }>)[0].text).toMatch(/Session not found/);
  });
});
