// Extension bridge: a loopback-only HTTP server (Bridge Protocol v1) that the
// VESTI browser extension talks to. Pure Node — Electron bits (safeStorage,
// settings.json, webContents) are injected so this class runs under vitest.
//
// Endpoints:
//   GET  /v1/status  → 200 {app, version, protocol, capabilities} (no auth)
//   POST /v1/pair    → 200 {token} | 401 {error}                 (pair code)
//   POST /v1/import  → 200 {conversations, messages, cursor}
//                      | 202 {accepted:true} | 400 | 401 | 413   (Bearer token)
//
// Bridge Protocol v1.1 (P4a relay outbox) — additive; extensions should
// feature-detect via the "outbox" capability in /v1/status (a v1.0 app
// answers 404 on these routes):
//   GET  /v1/outbox?after=<id>
//                      → 200 {items:[{id, prompt, createdAt}]}  (Bearer token)
//                        Items are id-ascending; `after` is an exclusive
//                        cursor (omit or 0 for the full backlog). Poll on an
//                        interval and persist the highest seen id.
//   POST /v1/outbox/ack {ids:[<id>, ...]}
//                      → 200 {acked:<n>} | 400 | 401            (Bearer token)
//                        Deletes delivered items after the extension has
//                        injected them; unknown ids are ignored.
// Items are enqueued app-side (renderer → IPC relayOutboxEnqueue →
// enqueueOutbox), capped at MAX_OUTBOX_ITEMS (oldest dropped), and persisted
// via the injected loadOutbox/saveOutbox callbacks (settings.json in
// production, in-memory in tests).

import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export const BRIDGE_PROTOCOL_VERSION = 1;
export const BRIDGE_APP_NAME = 'vesti-desktop';
export const DEFAULT_BRIDGE_PORT = 28765;
export const MAX_IMPORT_BODY_BYTES = 200 * 1024 * 1024;
export const PAIR_CODE_TTL_MS = 5 * 60 * 1000;
export const IMPORT_RESPONSE_TIMEOUT_MS = 60_000;
/** v1.1 outbox: backlog cap (oldest items dropped) and per-prompt size cap. */
export const MAX_OUTBOX_ITEMS = 50;
export const MAX_OUTBOX_PROMPT_CHARS = 20_000;

const PAIR_BODY_LIMIT_BYTES = 64 * 1024;
const OUTBOX_ACK_BODY_LIMIT_BYTES = 64 * 1024;
const MAX_NAME_LENGTH = 200;

export interface BridgeOutboxItem {
  id: number;
  prompt: string;
  createdAt: number;
}

export interface BridgeClientRecord {
  clientId: string;
  client: string;
  tokenEncrypted: string;
  pairedAt: number;
  lastSyncAt: number | null;
}

export interface ExtensionImportCounts {
  conversations: number;
  messages: number;
  /** ISO timestamp of the newest imported record; echoed back as the cursor. */
  maxCapturedAt: string | null;
}

export interface ExtensionBridgeStatus {
  running: boolean;
  port: number;
  error: string | null;
  clients: Array<Omit<BridgeClientRecord, 'tokenEncrypted'>>;
}

export interface ExtensionBridgeOptions {
  appVersion: string;
  port?: number;
  host?: string;
  maxImportBodyBytes?: number;
  pairCodeTtlMs?: number;
  importTimeoutMs?: number;
  /** safeStorage.encryptString(plain).toString('base64') in production. */
  encrypt: (plainText: string) => string;
  /** safeStorage.decryptString(Buffer.from(payload, 'base64')) in production. May throw. */
  decrypt: (payload: string) => string;
  loadClients: () => BridgeClientRecord[];
  saveClients: (clients: BridgeClientRecord[]) => void | Promise<void>;
  /** v1.1 outbox persistence (settings.json bridge.outbox in production).
   * Optional: tests may leave them unset and get an in-memory outbox. */
  loadOutbox?: () => BridgeOutboxItem[];
  saveOutbox?: (items: BridgeOutboxItem[]) => void | Promise<void>;
  /** Runs the renderer-side idempotent import; resolves with per-import counts. */
  importBundle: (bundle: unknown, since: string | undefined) => Promise<ExtensionImportCounts>;
  onClientsChanged?: () => void;
  log?: (line: string) => void;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class ExtensionBridgeService {
  private server: Server | null = null;
  private clients: BridgeClientRecord[] = [];
  private outbox: BridgeOutboxItem[] = [];
  private activePairCode: { code: string; expiresAt: number } | null = null;
  private running = false;
  private lastError: string | null = null;
  private boundPort: number;

  constructor(private readonly options: ExtensionBridgeOptions) {
    this.boundPort = options.port ?? DEFAULT_BRIDGE_PORT;
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.clients = this.sanitizeClients(this.options.loadClients());
    this.outbox = this.sanitizeOutbox(this.options.loadOutbox?.() ?? []);
    this.server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    await new Promise<void>((resolve) => {
      const server = this.server!;
      server.once('error', (error: NodeJS.ErrnoException) => {
        this.lastError = error.code === 'EADDRINUSE'
          ? `port ${this.boundPort} already in use`
          : error.message;
        this.log(`extension bridge failed to start: ${this.lastError}`);
        this.server = null;
        resolve();
      });
      server.listen(this.boundPort, this.options.host ?? '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address === 'object') this.boundPort = address.port;
        this.running = true;
        this.lastError = null;
        this.log(`extension bridge listening on 127.0.0.1:${this.boundPort}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.running = false;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  getStatus(): ExtensionBridgeStatus {
    return {
      running: this.running,
      port: this.boundPort,
      error: this.lastError,
      clients: this.clients.map(({ tokenEncrypted: _tokenEncrypted, ...client }) => client),
    };
  }

  /** 6-digit one-time code; generating a new one invalidates the previous. */
  createPairCode(): { code: string; expiresAt: number } {
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    this.activePairCode = {
      code,
      expiresAt: Date.now() + (this.options.pairCodeTtlMs ?? PAIR_CODE_TTL_MS),
    };
    return { ...this.activePairCode };
  }

  async disconnectClient(clientId: string): Promise<boolean> {
    const before = this.clients.length;
    this.clients = this.clients.filter((client) => client.clientId !== clientId);
    if (this.clients.length === before) return false;
    await this.persistClients();
    return true;
  }

  /** App-side enqueue (renderer → IPC). Ids are monotonically increasing so
   * the extension can poll with an exclusive `after` cursor. */
  async enqueueOutbox(prompt: string): Promise<BridgeOutboxItem> {
    const trimmed = prompt.trim();
    if (!trimmed) throw new Error('outbox prompt is empty');
    if (trimmed.length > MAX_OUTBOX_PROMPT_CHARS) {
      throw new Error(`outbox prompt exceeds ${MAX_OUTBOX_PROMPT_CHARS} chars`);
    }
    const nextId = this.outbox.reduce((max, item) => Math.max(max, item.id), 0) + 1;
    const item: BridgeOutboxItem = { id: nextId, prompt: trimmed, createdAt: Date.now() };
    this.outbox = [...this.outbox, item].slice(-MAX_OUTBOX_ITEMS);
    await this.persistOutbox();
    return { ...item };
  }

  getOutboxSize(): number {
    return this.outbox.length;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/v1/status') {
        this.sendJson(response, 200, {
          app: BRIDGE_APP_NAME,
          version: this.options.appVersion,
          protocol: BRIDGE_PROTOCOL_VERSION,
          capabilities: ['pair', 'import', 'outbox'],
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/pair') {
        await this.handlePair(request, response);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/import') {
        await this.handleImport(request, response);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/outbox') {
        this.handleOutboxList(request, response, url);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/outbox/ack') {
        await this.handleOutboxAck(request, response);
        return;
      }
      this.sendJson(response, 404, { error: 'not_found' });
    } catch (error) {
      if (error instanceof HttpError) {
        this.sendJson(response, error.status, { error: error.message });
      } else {
        this.log(`extension bridge request failed: ${(error as Error).message}`);
        this.sendJson(response, 500, { error: 'internal_error' });
      }
    }
  }

  private async handlePair(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody(request, PAIR_BODY_LIMIT_BYTES);
    if (!body || typeof body !== 'object') throw new HttpError(400, 'invalid_body');
    const { code, client, clientId } = body as Record<string, unknown>;
    if (
      typeof code !== 'string'
      || typeof client !== 'string'
      || typeof clientId !== 'string'
      || !client.trim()
      || !clientId.trim()
      || client.length > MAX_NAME_LENGTH
      || clientId.length > MAX_NAME_LENGTH
    ) {
      throw new HttpError(400, 'invalid_body');
    }

    const active = this.activePairCode;
    const codeOk = active !== null
      && Date.now() < active.expiresAt
      && safeEqual(code, active.code);
    if (!codeOk) throw new HttpError(401, 'invalid_pair_code');

    let tokenEncrypted: string;
    const token = randomBytes(24).toString('base64url');
    try {
      tokenEncrypted = this.options.encrypt(token);
    } catch (error) {
      this.log(`extension bridge encryption unavailable: ${(error as Error).message}`);
      throw new HttpError(500, 'encryption_unavailable');
    }

    // The code is single-use: consume it before persisting the client.
    this.activePairCode = null;
    const record: BridgeClientRecord = {
      clientId: clientId.trim(),
      client: client.trim(),
      tokenEncrypted,
      pairedAt: Date.now(),
      lastSyncAt: null,
    };
    this.clients = [...this.clients.filter((item) => item.clientId !== record.clientId), record];
    await this.persistClients();
    this.sendJson(response, 200, { token });
  }

  private async handleImport(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const token = bearerToken(request.headers.authorization);
    const client = token ? this.findClientByToken(token) : null;
    if (!client) throw new HttpError(401, 'unauthorized');

    const body = await readJsonBody(request, this.options.maxImportBodyBytes ?? MAX_IMPORT_BODY_BYTES);
    if (!body || typeof body !== 'object') throw new HttpError(400, 'invalid_body');
    const { format, since, data } = body as Record<string, unknown>;
    if (format !== 'vesti_export.v1') throw new HttpError(400, 'unsupported_format');
    if (since !== undefined && typeof since !== 'string') throw new HttpError(400, 'invalid_since');
    if (!data || typeof data !== 'object') throw new HttpError(400, 'missing_data');

    let result: ExtensionImportCounts;
    try {
      result = await withTimeout(
        this.options.importBundle(data, since as string | undefined),
        this.options.importTimeoutMs ?? IMPORT_RESPONSE_TIMEOUT_MS,
      );
    } catch (error) {
      if (error instanceof ImportTimeoutError) {
        // The renderer may still finish the (idempotent) import; the extension
        // retries with the same data, so accepting here is safe.
        this.sendJson(response, 202, { accepted: true });
        return;
      }
      this.log(`extension import failed: ${(error as Error).message}`);
      this.sendJson(response, 500, { error: 'import_failed' });
      return;
    }

    client.lastSyncAt = Date.now();
    await this.persistClients();
    this.sendJson(response, 200, {
      conversations: result.conversations,
      messages: result.messages,
      cursor: result.maxCapturedAt ?? (since as string | undefined) ?? '',
    });
  }

  /** GET /v1/outbox?after=<id> — exclusive cursor, id-ascending items. */
  private handleOutboxList(request: IncomingMessage, response: ServerResponse, url: URL): void {
    const token = bearerToken(request.headers.authorization);
    if (!token || !this.findClientByToken(token)) throw new HttpError(401, 'unauthorized');
    const rawAfter = url.searchParams.get('after');
    const after = rawAfter === null ? 0 : Number(rawAfter);
    if (!Number.isInteger(after) || after < 0) throw new HttpError(400, 'invalid_after');
    const items = this.outbox
      .filter((item) => item.id > after)
      .map((item) => ({ ...item }));
    this.sendJson(response, 200, { items });
  }

  /** POST /v1/outbox/ack {ids:[...]} — delete delivered items. */
  private async handleOutboxAck(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const token = bearerToken(request.headers.authorization);
    if (!token || !this.findClientByToken(token)) throw new HttpError(401, 'unauthorized');
    const body = await readJsonBody(request, OUTBOX_ACK_BODY_LIMIT_BYTES);
    if (!body || typeof body !== 'object') throw new HttpError(400, 'invalid_body');
    const { ids } = body as Record<string, unknown>;
    if (
      !Array.isArray(ids)
      || ids.length > 200
      || ids.some((id) => !Number.isInteger(id) || (id as number) < 1)
    ) {
      throw new HttpError(400, 'invalid_ids');
    }
    const acked = new Set(ids as number[]);
    const before = this.outbox.length;
    this.outbox = this.outbox.filter((item) => !acked.has(item.id));
    if (this.outbox.length !== before) await this.persistOutbox();
    this.sendJson(response, 200, { acked: before - this.outbox.length });
  }

  private findClientByToken(token: string): BridgeClientRecord | null {    for (const client of this.clients) {
      try {
        if (safeEqual(this.options.decrypt(client.tokenEncrypted), token)) return client;
      } catch {
        // Skip entries that no longer decrypt (e.g. OS keychain rotated).
      }
    }
    return null;
  }

  private async persistClients(): Promise<void> {
    await this.options.saveClients(this.clients);
    this.options.onClientsChanged?.();
  }

  private async persistOutbox(): Promise<void> {
    await this.options.saveOutbox?.(this.outbox.map((item) => ({ ...item })));
  }

  private sanitizeOutbox(records: BridgeOutboxItem[]): BridgeOutboxItem[] {
    return (Array.isArray(records) ? records : [])
      .filter(
        (record) => record
          && Number.isInteger(record.id)
          && record.id >= 1
          && typeof record.prompt === 'string'
          && typeof record.createdAt === 'number',
      )
      .map((record) => ({ ...record }))
      .sort((a, b) => a.id - b.id)
      .slice(-MAX_OUTBOX_ITEMS);
  }

  private sanitizeClients(records: BridgeClientRecord[]): BridgeClientRecord[] {
    return (Array.isArray(records) ? records : []).filter(
      (record) => record
        && typeof record.clientId === 'string'
        && typeof record.client === 'string'
        && typeof record.tokenEncrypted === 'string'
        && typeof record.pairedAt === 'number',
    ).map((record) => ({ ...record, lastSyncAt: record.lastSyncAt ?? null }));
  }

  private sendJson(response: ServerResponse, status: number, body: unknown): void {
    if (response.writableEnded) return;
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
  }

  private log(line: string): void {
    this.options.log?.(line);
  }
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

class ImportTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ImportTimeoutError()), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function readJsonBody(request: IncomingMessage, limitBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > limitBytes) {
      // Drain (don't destroy) so the 413 response can still be delivered.
      request.resume();
      reject(new HttpError(413, 'body_too_large'));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    request.on('data', (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > limitBytes) {
        aborted = true;
        request.resume();
        reject(new HttpError(413, 'body_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        reject(new HttpError(400, 'empty_body'));
        return;
      }
      try {
        resolve(JSON.parse(raw) as unknown);
      } catch {
        reject(new HttpError(400, 'invalid_json'));
      }
    });
    request.on('error', () => reject(new HttpError(400, 'invalid_body')));
  });
}
