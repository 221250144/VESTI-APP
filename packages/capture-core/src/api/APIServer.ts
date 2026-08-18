/**
 * API Server v2
 * Express HTTP + WebSocket for web dashboard
 * New routes: /api/sessions, /api/sessions/:id/turns, /api/sessions/:id/events
 */

import express from 'express';
import cors from 'cors';
import { createServer, type Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import type { DatabaseManager } from '../storage/DatabaseManager.js';
import type { SearchEngine } from '../search/SearchEngine.js';
import type { ExportEngine } from '../export/ExportEngine.js';
import {
  workSessionToVestiConversation,
  sessionMessagesToVestiMessages,
  firstVisibleUserSnippet,
  resolveCliId,
  cliIdToNumeric,
  registerCliId,
  reverseMapPlatform,
} from './vestiCompat.js';

export class APIServer {
  private app: express.Application;
  private server?: Server;
  private wss?: WebSocketServer;

  constructor(
    private db: DatabaseManager,
    private search: SearchEngine,
    private exportEngine: ExportEngine,
    private host: string,
    private port: number,
    private webDistPath?: string,
  ) {
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use(cors());
    this.app.use(express.json({ limit: '10mb' }));
  }

  private setupRoutes(): void {
    // Health
    this.app.get('/health', (_req, res) => {
      res.json({ status: 'ok', version: '0.2.0' });
    });

    // v2: Sessions (primary)
    this.app.get('/api/sessions', (req, res) => {
      try {
        const limit = parseInt(req.query.limit as string) || 50;
        const offset = parseInt(req.query.offset as string) || 0;
        const platform = req.query.platform as string | undefined;
        const sessionType = (req.query.type as string) || 'conversation';
        const sessions = this.db.listWorkSessions({ platform, sessionType: req.query.all === 'true' ? undefined : sessionType, limit, offset });
        res.json({ sessions });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.get('/api/sessions/:id', (req, res) => {
      try {
        const session = this.db.getWorkSession(req.params.id);
        if (!session) return res.status(404).json({ error: 'Not found' });
        res.json({ session });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.get('/api/sessions/:id/turns', (req, res) => {
      try {
        const turns = this.db.getTurns(req.params.id);
        res.json({ turns });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.get('/api/sessions/:id/messages', (req, res) => {
      try {
        const source = req.query.source as string | undefined;
        const messages = this.db.getSessionMessages(req.params.id, { source });
        res.json({ messages });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.get('/api/sessions/:id/tools', (req, res) => {
      try {
        const tools = this.db.getUnifiedToolExecutions(req.params.id);
        res.json({ toolExecutions: tools });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.get('/api/sessions/:id/events', (req, res) => {
      try {
        const events = this.db.getSystemEvents(req.params.id);
        res.json({ events });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.get('/api/sessions/:id/subagents', (req, res) => {
      try {
        const subagents = this.db.getSubagentLinks(req.params.id);
        res.json({ subagents });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // v1 compat: Conversations (aliases)
    this.app.get('/api/conversations', (req, res) => {
      try {
        const limit = parseInt(req.query.limit as string) || 50;
        const offset = parseInt(req.query.offset as string) || 0;
        const platform = req.query.platform as string | undefined;
        const conversations = this.db.listConversations({ platform, sessionType: req.query.all === 'true' ? undefined : 'conversation', limit, offset });
        res.json({ conversations });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.get('/api/conversations/:id', (req, res) => {
      try {
        const conv = this.db.getConversation(req.params.id);
        if (!conv) return res.status(404).json({ error: 'Not found' });
        res.json({ conversation: conv });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.get('/api/conversations/:id/messages', (req, res) => {
      try {
        const messages = this.db.getMessages(req.params.id);
        res.json({ messages });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.get('/api/conversations/:id/tools', (req, res) => {
      try {
        const tools = this.db.getToolExecutions(req.params.id);
        res.json({ toolExecutions: tools });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.get('/api/conversations/:id/subagents', (req, res) => {
      try {
        const subagents = this.db.getSubagents(req.params.id);
        res.json({ subagents });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // Search
    this.app.get('/api/search', (req, res) => {
      try {
        const q = req.query.q as string;
        if (!q) return res.status(400).json({ error: 'Missing query parameter q' });
        const limit = parseInt(req.query.limit as string) || 20;
        const results = this.search.search({ text: q, limit });
        res.json({ results });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // Stats
    this.app.get('/api/stats', (_req, res) => {
      try {
        const stats = this.db.getStats();
        res.json(stats);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // Export
    this.app.get('/api/conversations/:id/export', async (req, res) => {
      try {
        const format = (req.query.format as string) || 'json';
        const content = await this.exportEngine.exportConversation(req.params.id, {
          format: format as 'json' | 'markdown',
          includeThinking: req.query.thinking !== 'false',
          includeToolCalls: req.query.tools !== 'false',
        });
        if (format === 'json') {
          res.type('application/json').send(content);
        } else {
          res.type('text/markdown').send(content);
        }
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // ==================== VESTI Mainline Compatibility API ====================

    // Ping — health check for local terminal availability
    this.app.get('/api/vesti/ping', (_req, res) => {
      res.json({ ok: true, source: 'vesti-cli', timestamp: Date.now() });
    });

    // List conversations in VESTI mainline format
    this.app.get('/api/vesti/conversations', (req, res) => {
      try {
        const limit = parseInt(req.query.limit as string) || 50;
        const offset = parseInt(req.query.offset as string) || 0;
        const rawPlatform = req.query.platform as string | undefined;
        // Reverse map: "Claude" → "claude-code" for DB query
        const platform = rawPlatform ? (reverseMapPlatform(rawPlatform) || rawPlatform) : undefined;
        const sessions = this.db.listWorkSessions({
          platform,
          sessionType: 'conversation',
          limit,
          offset,
        });

        const conversations = sessions.map(ws => {
          const messages = this.db.getSessionMessages(ws.id);
          const visibleMessages = sessionMessagesToVestiMessages(
            messages,
            cliIdToNumeric(ws.id),
            ws.platform,
          );
          return workSessionToVestiConversation(
            ws,
            firstVisibleUserSnippet(messages, 100, ws.platform),
            {
              messageCount: visibleMessages.length,
              turnCount: visibleMessages.filter(message => message.role === 'user').length,
            },
          );
        });

        res.json({ conversations });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // Get single conversation
    this.app.get('/api/vesti/conversations/:id', (req, res) => {
      try {
        const cliId = resolveCliId(req.params.id);
        if (!cliId) {
          return res.status(404).json({ error: 'Not found' });
        }
        const ws = this.db.getWorkSession(cliId);
        if (!ws) {
          return res.status(404).json({ error: 'Not found' });
        }
        const messages = this.db.getSessionMessages(ws.id);
        const visibleMessages = sessionMessagesToVestiMessages(
          messages,
          cliIdToNumeric(ws.id),
          ws.platform,
        );
        const snippet = firstVisibleUserSnippet(messages, 100, ws.platform);
        res.json({
          conversation: workSessionToVestiConversation(ws, snippet, {
            messageCount: visibleMessages.length,
            turnCount: visibleMessages.filter(message => message.role === 'user').length,
          }),
        });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // Get messages for a conversation in VESTI mainline format
    this.app.get('/api/vesti/conversations/:id/messages', (req, res) => {
      try {
        const cliId = resolveCliId(req.params.id);
        if (!cliId) {
          return res.status(404).json({ error: 'Not found' });
        }
        const numericId = cliIdToNumeric(cliId);
        const messages = this.db.getSessionMessages(cliId);
        const platform = this.db.getWorkSession(cliId)?.platform;
        const vestiMessages = sessionMessagesToVestiMessages(messages, numericId, platform);
        res.json({ messages: vestiMessages });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // Stats for local terminal data
    this.app.get('/api/vesti/stats', (_req, res) => {
      try {
        const stats = this.db.getStats();
        res.json({
          source: 'local_terminal',
          ...stats,
        });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // Serve web dashboard static files
    if (this.webDistPath) {
      this.app.use(express.static(this.webDistPath));
      this.app.get('*', (_req, res) => {
        res.sendFile(path.join(this.webDistPath!, 'index.html'));
      });
    }
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer(this.app);

      // WebSocket
      this.wss = new WebSocketServer({ server: this.server });
      this.wss.on('connection', (ws) => {
        ws.send(JSON.stringify({ type: 'CONNECTED', timestamp: Date.now() }));
      });

      this.server.listen(this.port, this.host, () => {
        resolve();
      });
    });
  }

  broadcast(data: unknown): void {
    if (!this.wss) return;
    const msg = JSON.stringify(data);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.wss?.close();
      this.server?.close(() => resolve());
    });
  }
}
