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
//
// Bridge Protocol v1.2 (one-tap TOFU auto-connect) — additive; extensions
// feature-detect via the "associate" capability and the "pairing_window"
// field in /v1/status:
//   POST /v1/associate {client, clientId}
//                      → 200 {token} | 403 | 409 | 429
//                        While the pairing window is open the request is held
//                        synchronously until the injected confirmAssociation
//                        callback (a native dialog in production) resolves:
//                        allow → 200 {token}, deny/timeout (60s) → 403.
//                        Window closed → 409 pairing_window_closed; another
//                        association pending → 409 associate_busy; more than
//                        ASSOCIATE_RATE_LIMIT_PER_MINUTE attempts per clientId
//                        per minute → 429 rate_limited. Re-associating an
//                        already-paired clientId rotates its token (the old
//                        one stops working), exactly like /v1/pair.
// The pairing window opens automatically at startup (10 min) and can be
// reopened from the settings UI (5 min) — this is the anti-silent-grab
// control: loopback alone is not authentication, so a local process can only
// obtain a token while the window is open AND the user taps "allow".
// Browser (extension) traffic on /v1/status|pair|associate gets Private
// Network Access preflight answers and origin-scoped CORS; the
// token-authenticated /v1/import|outbox routes stay CORS-free. An optional
// origin allowlist (settings bridge.originAllowlist) can pin exact
// chrome-extension://<id> origins — off by default because dev-mode
// extension ids are random; the TOFU dialog remains the real gate.

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
/** v1.2 TOFU associate: window durations, per-clientId rate limit, and the
 * synchronous user-confirm timeout. */
export const STARTUP_PAIRING_WINDOW_MS = 10 * 60 * 1000;
export const MANUAL_PAIRING_WINDOW_MS = 5 * 60 * 1000;
export const ASSOCIATE_CONFIRM_TIMEOUT_MS = 60_000;
export const ASSOCIATE_RATE_LIMIT_PER_MINUTE = 3;
export const ASSOCIATE_RATE_WINDOW_MS = 60_000;

const PAIR_BODY_LIMIT_BYTES = 64 * 1024;
const OUTBOX_ACK_BODY_LIMIT_BYTES = 64 * 1024;
const MAX_NAME_LENGTH = 200;
/** Browser-facing endpoints that answer CORS/PNA preflights. The Bearer-token
 * routes (/v1/import, /v1/outbox*) are non-browser channels and stay
 * CORS-free on purpose. */
const CORS_ENDPOINT_PATHS = new Set(['/v1/status', '/v1/pair', '/v1/associate']);

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
  /** v1.2: TOFU pairing window state for the settings UI. */
  pairingWindow: { open: boolean; expiresAt: number | null };
}

/** v1.2: a pending /v1/associate request awaiting user confirmation. */
export interface BridgeAssociationRequest {
  client: string;
  clientId: string;
}

export interface ExtensionBridgeOptions {
  appVersion: string;
  /** Runtime entitlement guard. Requests are rejected even if a logout races
   * with server shutdown. Omitted in tests and non-membership hosts. */
  isAuthorized?: () => boolean;
  port?: number;
  host?: string;
  maxImportBodyBytes?: number;
  pairCodeTtlMs?: number;
  importTimeoutMs?: number;
  /** v1.2: pairing window auto-opened at start (default 10 min; 0 disables). */
  startupPairingWindowMs?: number;
  /** v1.2: how long a held /v1/associate request waits for the user. */
  associateConfirmTimeoutMs?: number;
  /** v1.2: synchronous TOFU gate — resolves true to issue a token, false to
   * reject. In production this shows a native dialog. Without it every
   * association is rejected. */
  confirmAssociation?: (request: BridgeAssociationRequest) => Promise<boolean>;
  /** v1.2: exact chrome-extension://<id> origins allowed to call the
   * browser-facing endpoints; empty (default) means no Origin enforcement —
   * the TOFU confirm dialog remains the gate. Read per request so settings
   * edits apply without a restart. */
  loadOriginAllowlist?: () => string[];
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
  /** v1.2: fired when the pairing window opens or closes (UI refresh). */
  onPairingWindowChanged?: () => void;
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
  private pairingWindowExpiresAt: number | null = null;
  private pairingWindowTimer: NodeJS.Timeout | null = null;
  /** clientId of the association currently awaiting user confirm (max 1). */
  private pendingAssociation: string | null = null;
  /** v1.2 rate limit: associate attempt timestamps per clientId. */
  private readonly associateAttempts = new Map<string, number[]>();
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
    // TOFU: freshly started apps accept association prompts for a while so a
    // newly installed extension can connect without the settings page.
    const startupWindowMs = this.options.startupPairingWindowMs ?? STARTUP_PAIRING_WINDOW_MS;
    if (this.running && startupWindowMs > 0) this.openPairingWindow(startupWindowMs);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.running = false;
    if (this.pairingWindowTimer) {
      clearTimeout(this.pairingWindowTimer);
      this.pairingWindowTimer = null;
    }
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  getStatus(): ExtensionBridgeStatus {
    const windowOpen = this.isPairingWindowOpen();
    return {
      running: this.running,
      port: this.boundPort,
      error: this.lastError,
      clients: this.clients.map(({ tokenEncrypted: _tokenEncrypted, ...client }) => client),
      pairingWindow: {
        open: windowOpen,
        expiresAt: windowOpen ? this.pairingWindowExpiresAt : null,
      },
    };
  }

  isPairingWindowOpen(): boolean {
    return this.pairingWindowExpiresAt !== null && Date.now() < this.pairingWindowExpiresAt;
  }

  /** v1.2: (re)open the TOFU pairing window. Startup opens 10 min; the
   * settings UI reopens it for MANUAL_PAIRING_WINDOW_MS (5 min). */
  openPairingWindow(durationMs: number = MANUAL_PAIRING_WINDOW_MS): { expiresAt: number } {
    this.pairingWindowExpiresAt = Date.now() + Math.max(1, durationMs);
    if (this.pairingWindowTimer) clearTimeout(this.pairingWindowTimer);
    this.pairingWindowTimer = setTimeout(() => {
      this.pairingWindowTimer = null;
      if (!this.isPairingWindowOpen()) this.options.onPairingWindowChanged?.();
    }, this.pairingWindowExpiresAt - Date.now());
    // Never keep the process alive just to close a window.
    this.pairingWindowTimer.unref();
    this.options.onPairingWindowChanged?.();
    return { expiresAt: this.pairingWindowExpiresAt };
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
      if (this.options.isAuthorized?.() === false) {
        this.sendJson(response, 403, { error: 'membership_required' });
        return;
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      // Private Network Access: Chrome extensions send a preflight before
      // calling a loopback service; answer it for the browser-facing routes.
      if (request.method === 'OPTIONS') {
        this.handlePreflight(request, response, url.pathname);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/status') {
        this.sendJson(response, 200, {
          app: BRIDGE_APP_NAME,
          version: this.options.appVersion,
          protocol: BRIDGE_PROTOCOL_VERSION,
          capabilities: ['pair', 'import', 'outbox', 'associate'],
          pairing_window: this.isPairingWindowOpen() ? 'open' : 'closed',
        }, this.browserCorsHeaders(request));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/pair') {
        await this.handlePair(request, response, this.browserCorsHeaders(request));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/associate') {
        await this.handleAssociate(request, response, this.browserCorsHeaders(request));
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

  private async handlePair(
    request: IncomingMessage,
    response: ServerResponse,
    corsHeaders: Record<string, string>,
  ): Promise<void> {
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

    // The code is single-use: consume it before issuing the token.
    this.activePairCode = null;
    const token = await this.issueToken(clientId.trim(), client.trim());
    this.sendJson(response, 200, { token }, corsHeaders);
  }

  /**
   * POST /v1/associate {client, clientId} — v1.2 one-tap TOFU. The request is
   * held open while the user answers the confirm dialog (synchronous mode);
   * re-associating a known clientId rotates its token, exactly like /v1/pair.
   */
  private async handleAssociate(
    request: IncomingMessage,
    response: ServerResponse,
    corsHeaders: Record<string, string>,
  ): Promise<void> {
    const body = await readJsonBody(request, PAIR_BODY_LIMIT_BYTES);
    if (!body || typeof body !== 'object') throw new HttpError(400, 'invalid_body');
    const { client, clientId } = body as Record<string, unknown>;
    if (
      typeof client !== 'string'
      || typeof clientId !== 'string'
      || !client.trim()
      || !clientId.trim()
      || client.length > MAX_NAME_LENGTH
      || clientId.length > MAX_NAME_LENGTH
    ) {
      throw new HttpError(400, 'invalid_body');
    }

    const id = clientId.trim();
    this.noteAssociateAttempt(id);
    if (!this.isPairingWindowOpen()) throw new HttpError(409, 'pairing_window_closed');
    if (this.pendingAssociation) throw new HttpError(409, 'associate_busy');
    if (!this.options.confirmAssociation) throw new HttpError(403, 'association_rejected');

    this.pendingAssociation = id;
    try {
      let allowed: boolean;
      try {
        allowed = await withTimeout(
          this.options.confirmAssociation({ client: client.trim(), clientId: id }),
          this.options.associateConfirmTimeoutMs ?? ASSOCIATE_CONFIRM_TIMEOUT_MS,
        );
      } catch (error) {
        if (error instanceof OperationTimeoutError) throw new HttpError(403, 'association_timeout');
        throw error;
      }
      if (!allowed) throw new HttpError(403, 'association_rejected');
      const token = await this.issueToken(id, client.trim());
      this.sendJson(response, 200, { token }, corsHeaders);
    } finally {
      this.pendingAssociation = null;
    }
  }

  /** Mint + persist a token for a client; an existing record with the same
   * clientId is replaced (its old token stops working). */
  private async issueToken(clientId: string, client: string): Promise<string> {
    let tokenEncrypted: string;
    const token = randomBytes(24).toString('base64url');
    try {
      tokenEncrypted = this.options.encrypt(token);
    } catch (error) {
      this.log(`extension bridge encryption unavailable: ${(error as Error).message}`);
      throw new HttpError(500, 'encryption_unavailable');
    }
    const record: BridgeClientRecord = {
      clientId,
      client,
      tokenEncrypted,
      pairedAt: Date.now(),
      lastSyncAt: null,
    };
    this.clients = [...this.clients.filter((item) => item.clientId !== record.clientId), record];
    await this.persistClients();
    return token;
  }

  /** Sliding-window rate limit on /v1/associate attempts, keyed by clientId
   * (every caller shares the 127.0.0.1 source IP, so IP keying is useless). */
  private noteAssociateAttempt(clientId: string): void {
    const now = Date.now();
    const windowStart = now - ASSOCIATE_RATE_WINDOW_MS;
    const attempts = (this.associateAttempts.get(clientId) ?? []).filter((at) => at > windowStart);
    if (attempts.length >= ASSOCIATE_RATE_LIMIT_PER_MINUTE) throw new HttpError(429, 'rate_limited');
    attempts.push(now);
    this.associateAttempts.set(clientId, attempts);
  }

  /** PNA + CORS preflight answers for the browser-facing endpoints. Without
   * an allowed Origin we still answer 204 but omit ACAO, so the browser
   * blocks the follow-up request. */
  private handlePreflight(request: IncomingMessage, response: ServerResponse, pathname: string): void {
    if (!CORS_ENDPOINT_PATHS.has(pathname)) {
      this.sendJson(response, 404, { error: 'not_found' });
      return;
    }
    const headers: Record<string, string> = {
      'access-control-allow-private-network': 'true',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-max-age': '600',
    };
    const origin = this.allowedBrowserOrigin(request);
    if (origin) {
      headers['access-control-allow-origin'] = origin;
      headers.vary = 'Origin';
    }
    response.writeHead(204, headers);
    response.end();
  }

  /** CORS response headers for actual requests to browser-facing endpoints.
   * Only chrome-extension:// origins get ACAO (web pages can't read the
   * bridge). With a configured allowlist, a chrome-extension Origin outside
   * the list is a hard 403; non-extension/no-Origin clients (curl, token
   * holders) are unaffected — Origin checks are a browser-only signal. */
  private browserCorsHeaders(request: IncomingMessage): Record<string, string> {
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || !origin.startsWith('chrome-extension://')) return {};
    const allowed = this.allowedBrowserOrigin(request);
    if (!allowed) throw new HttpError(403, 'origin_not_allowed');
    return { 'access-control-allow-origin': allowed, vary: 'Origin' };
  }

  private allowedBrowserOrigin(request: IncomingMessage): string | null {
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || !origin.startsWith('chrome-extension://')) return null;
    const allowlist = this.options.loadOriginAllowlist?.() ?? [];
    if (allowlist.length > 0 && !allowlist.includes(origin)) return null;
    return origin;
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
      if (error instanceof OperationTimeoutError) {
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

  private sendJson(
    response: ServerResponse,
    status: number,
    body: unknown,
    extraHeaders: Record<string, string> = {},
  ): void {
    if (response.writableEnded) return;
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extraHeaders });
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

class OperationTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new OperationTimeoutError()), timeoutMs);
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
