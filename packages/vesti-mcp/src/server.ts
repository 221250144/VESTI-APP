/**
 * MCP server wiring. Uses the official @modelcontextprotocol/sdk low-level
 * Server with hand-written JSON Schemas (no zod dependency); the protocol
 * surface we need is just tools/list + tools/call.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { VestiDatabase } from './db.js';
import { vestiGetTurns, vestiSearch, vestiTimeline } from './tools.js';

const SEARCH_DESCRIPTION = [
  'Layer 1 of 3 — search VESTI’s memory of past AI-coding sessions (claude code, codex, kimi-code, …).',
  'Returns up to topK session index entries (~100 tokens each): session_id, title, platform, project, time, digest one-liner, key topics, and a hit snippet.',
  'WORKFLOW: (1) call vesti_search with a few keywords; (2) call vesti_timeline on the most promising session_id to see its turn outline; (3) call vesti_get_turns only for the turns you actually need.',
  'Do NOT guess session ids — they come from this tool.',
].join(' ');

const TIMELINE_DESCRIPTION = [
  'Layer 2 of 3 — turn-level outline of one session found via vesti_search.',
  'Returns each turn’s sequence number, timestamp, a one-line user-intent summary, tool-call count and token usage, so you can locate the exact passage worth reading.',
  'Pass around_turn to center a ±window view on a specific turn instead of the whole session.',
  'Then call vesti_get_turns with the turn seq numbers you selected.',
].join(' ');

const GET_TURNS_DESCRIPTION = [
  'Layer 3 of 3 — full message content for specific turns of a session (user input, assistant replies, tool-call summaries).',
  'Select turns by turn_ids (sequence numbers from vesti_timeline) or an inclusive {from,to} range. Output is capped at max_chars; when the cap is hit the response sets truncated=true and you should narrow the selection.',
  'This is the expensive layer — only fetch the turns vesti_timeline pointed to.',
].join(' ');

export function createVestiMcpServer(db: VestiDatabase): Server {
  const server = new Server(
    { name: 'vesti-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'vesti_search',
        description: SEARCH_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Keywords to recall (FTS-matched over all captured sessions).',
            },
            topK: {
              type: 'integer',
              description: 'Max session entries to return (default 8).',
              default: 8,
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'vesti_timeline',
        description: TIMELINE_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'Session id from vesti_search.',
            },
            around_turn: {
              type: 'integer',
              description: 'Turn sequence number to center the outline on (optional).',
            },
            window: {
              type: 'integer',
              description: 'Turns shown on each side of around_turn (default 10).',
              default: 10,
            },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'vesti_get_turns',
        description: GET_TURNS_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'Session id from vesti_search.',
            },
            turn_ids: {
              type: 'array',
              items: { type: 'integer' },
              description: 'Turn sequence numbers (from vesti_timeline) to fetch.',
            },
            range: {
              type: 'object',
              properties: {
                from: { type: 'integer' },
                to: { type: 'integer' },
              },
              required: ['from', 'to'],
              description: 'Inclusive turn-sequence range; ignored when turn_ids is given.',
            },
            max_chars: {
              type: 'integer',
              description: 'Character budget for the whole response (default 8000, min 500).',
              default: 8000,
            },
          },
          required: ['session_id'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params;
    try {
      let payload: unknown;
      switch (name) {
        case 'vesti_search':
          payload = vestiSearch(db, (args ?? {}) as { query: string; topK?: number });
          break;
        case 'vesti_timeline':
          payload = vestiTimeline(db, (args ?? {}) as Parameters<typeof vestiTimeline>[1]);
          break;
        case 'vesti_get_turns':
          payload = vestiGetTurns(db, (args ?? {}) as Parameters<typeof vestiGetTurns>[1]);
          break;
        default:
          return {
            isError: true,
            content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      };
    }
  });

  return server;
}

/** Connect the server to stdio; resolves once the transport is up. */
export async function serveStdio(db: VestiDatabase): Promise<Server> {
  const server = createVestiMcpServer(db);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
