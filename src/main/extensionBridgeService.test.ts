import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ExtensionBridgeService,
  type BridgeClientRecord,
  type ExtensionImportCounts,
} from './extensionBridgeService';

// In-memory safeStorage stand-in: proves tokens never hit persistence in
// plaintext while keeping the service electron-free under vitest.
function memoryCrypto() {
  return {
    encrypt: (plain: string) => Buffer.from(`enc:${plain}`, 'utf8').toString('base64'),
    decrypt: (payload: string) => {
      const raw = Buffer.from(payload, 'base64').toString('utf8');
      if (!raw.startsWith('enc:')) throw new Error('bad payload');
      return raw.slice(4);
    },
  };
}

const IMPORT_COUNTS: ExtensionImportCounts = {
  conversations: 2,
  messages: 5,
  maxCapturedAt: '2026-07-18T12:00:00.000Z',
};

interface Harness {
  service: ExtensionBridgeService;
  baseUrl: string;
  clients: BridgeClientRecord[];
  savedSnapshots: BridgeClientRecord[][];
  imported: Array<{ bundle: unknown; since: string | undefined }>;
}

async function startHarness(overrides?: {
  importBundle?: (bundle: unknown, since: string | undefined) => Promise<ExtensionImportCounts>;
  maxImportBodyBytes?: number;
  pairCodeTtlMs?: number;
  importTimeoutMs?: number;
  seedClients?: BridgeClientRecord[];
}): Promise<Harness> {
  const clients = [...(overrides?.seedClients ?? [])];
  const savedSnapshots: BridgeClientRecord[][] = [];
  const imported: Array<{ bundle: unknown; since: string | undefined }> = [];
  const service = new ExtensionBridgeService({
    appVersion: '0.3.0',
    port: 0,
    ...memoryCrypto(),
    loadClients: () => clients,
    saveClients: next => {
      savedSnapshots.push(next.map(client => ({ ...client })));
      clients.splice(0, clients.length, ...next);
    },
    importBundle: overrides?.importBundle ?? (async (bundle, since) => {
      imported.push({ bundle, since });
      return IMPORT_COUNTS;
    }),
    maxImportBodyBytes: overrides?.maxImportBodyBytes,
    pairCodeTtlMs: overrides?.pairCodeTtlMs,
    importTimeoutMs: overrides?.importTimeoutMs,
  });
  await service.start();
  const status = service.getStatus();
  return {
    service,
    baseUrl: `http://127.0.0.1:${status.port}`,
    clients,
    savedSnapshots,
    imported,
  };
}

async function pair(harness: Harness): Promise<string> {
  const { code } = harness.service.createPairCode();
  const response = await fetch(`${harness.baseUrl}/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, client: 'VESTI Chrome', clientId: 'chrome-1' }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { token: string };
  return body.token;
}

describe('ExtensionBridgeService', () => {
  let harness: Harness | null = null;

  beforeEach(() => {
    harness = null;
  });

  afterEach(async () => {
    await harness?.service.stop();
  });

  it('serves unauthenticated status', async () => {
    harness = await startHarness();
    const response = await fetch(`${harness.baseUrl}/v1/status`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      app: 'vesti-desktop',
      version: '0.3.0',
      protocol: 1,
      capabilities: ['pair', 'import', 'outbox'],
    });
  });

  it('rejects a wrong pair code with 401', async () => {
    harness = await startHarness();
    harness.service.createPairCode();
    const response = await fetch(`${harness.baseUrl}/v1/pair`, {
      method: 'POST',
      body: JSON.stringify({ code: '000000', client: 'x', clientId: 'y' }),
    });
    expect(response.status).toBe(401);
    expect(harness.clients).toHaveLength(0);
  });

  it('rejects malformed pair bodies with 400', async () => {
    harness = await startHarness();
    const { code } = harness.service.createPairCode();
    const response = await fetch(`${harness.baseUrl}/v1/pair`, {
      method: 'POST',
      body: JSON.stringify({ code, client: '', clientId: 'y' }),
    });
    expect(response.status).toBe(400);
  });

  it('expires pair codes', async () => {
    harness = await startHarness({ pairCodeTtlMs: -1 });
    const { code } = harness.service.createPairCode();
    const response = await fetch(`${harness.baseUrl}/v1/pair`, {
      method: 'POST',
      body: JSON.stringify({ code, client: 'x', clientId: 'y' }),
    });
    expect(response.status).toBe(401);
  });

  it('pairs once per code and persists an encrypted token', async () => {
    harness = await startHarness();
    const { code } = harness.service.createPairCode();
    const first = await fetch(`${harness.baseUrl}/v1/pair`, {
      method: 'POST',
      body: JSON.stringify({ code, client: 'VESTI Chrome', clientId: 'chrome-1' }),
    });
    expect(first.status).toBe(200);
    const { token } = await first.json() as { token: string };
    expect(token).toBeTruthy();

    // The code is single-use.
    const second = await fetch(`${harness.baseUrl}/v1/pair`, {
      method: 'POST',
      body: JSON.stringify({ code, client: 'other', clientId: 'other-1' }),
    });
    expect(second.status).toBe(401);

    // Persisted record holds only the encrypted token.
    expect(harness.savedSnapshots).toHaveLength(1);
    const stored = harness.savedSnapshots[0][0];
    expect(stored.clientId).toBe('chrome-1');
    expect(stored.tokenEncrypted).not.toContain(token);
    expect(harness.service.getStatus().clients[0].client).toBe('VESTI Chrome');
  });

  it('rejects import without a valid token', async () => {
    harness = await startHarness();
    const response = await fetch(`${harness.baseUrl}/v1/import`, {
      method: 'POST',
      headers: { authorization: 'Bearer nope' },
      body: JSON.stringify({ format: 'vesti_export.v1', data: {} }),
    });
    expect(response.status).toBe(401);

    const missing = await fetch(`${harness.baseUrl}/v1/import`, {
      method: 'POST',
      body: JSON.stringify({ format: 'vesti_export.v1', data: {} }),
    });
    expect(missing.status).toBe(401);
  });

  it('imports a bundle, echoes counts and cursor, and stamps lastSyncAt', async () => {
    harness = await startHarness();
    const token = await pair(harness);
    const response = await fetch(`${harness.baseUrl}/v1/import`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        format: 'vesti_export.v1',
        since: '2026-07-01T00:00:00.000Z',
        data: { schema_version: 'vesti_export.v1', data: { conversations: [], messages: [] } },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      conversations: IMPORT_COUNTS.conversations,
      messages: IMPORT_COUNTS.messages,
      cursor: IMPORT_COUNTS.maxCapturedAt,
    });
    expect(harness.imported).toHaveLength(1);
    expect(harness.imported[0].since).toBe('2026-07-01T00:00:00.000Z');
    const client = harness.service.getStatus().clients.find(item => item.clientId === 'chrome-1');
    expect(client?.lastSyncAt).toBeTypeOf('number');
  });

  it('rejects a wrong format with 400', async () => {
    harness = await startHarness();
    const token = await pair(harness);
    const response = await fetch(`${harness.baseUrl}/v1/import`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ format: 'vesti_export.v2', data: {} }),
    });
    expect(response.status).toBe(400);
  });

  it('rejects invalid JSON with 400', async () => {
    harness = await startHarness();
    const token = await pair(harness);
    const response = await fetch(`${harness.baseUrl}/v1/import`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: '{not json',
    });
    expect(response.status).toBe(400);
  });

  it('rejects oversized bodies with 413', async () => {
    harness = await startHarness({ maxImportBodyBytes: 1024 });
    const token = await pair(harness);
    const response = await fetch(`${harness.baseUrl}/v1/import`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        format: 'vesti_export.v1',
        data: { padding: 'x'.repeat(4096) },
      }),
    });
    expect(response.status).toBe(413);
  });

  it('answers 202 when the renderer import exceeds the timeout', async () => {
    harness = await startHarness({
      importTimeoutMs: 100,
      importBundle: () => new Promise<ExtensionImportCounts>(() => {}),
    });
    const token = await pair(harness);
    const response = await fetch(`${harness.baseUrl}/v1/import`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ format: 'vesti_export.v1', data: {} }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
  });

  it('authenticates seeded clients and disconnects them', async () => {
    const crypto = memoryCrypto();
    harness = await startHarness({
      seedClients: [{
        clientId: 'chrome-1',
        client: 'VESTI Chrome',
        tokenEncrypted: crypto.encrypt('secret-token'),
        pairedAt: Date.now(),
        lastSyncAt: null,
      }],
    });
    const ok = await fetch(`${harness.baseUrl}/v1/import`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret-token' },
      body: JSON.stringify({ format: 'vesti_export.v1', data: {} }),
    });
    expect(ok.status).toBe(200);

    expect(await harness.service.disconnectClient('chrome-1')).toBe(true);
    const rejected = await fetch(`${harness.baseUrl}/v1/import`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret-token' },
      body: JSON.stringify({ format: 'vesti_export.v1', data: {} }),
    });
    expect(rejected.status).toBe(401);
  });

  // ---- Bridge Protocol v1.1: relay outbox ----

  it('serves outbox items after the exclusive cursor and deletes them on ack', async () => {
    harness = await startHarness();
    const token = await pair(harness);
    const first = await harness.service.enqueueOutbox('提示词一');
    const second = await harness.service.enqueueOutbox('提示词二');
    const third = await harness.service.enqueueOutbox('提示词三');
    expect([first.id, second.id, third.id]).toEqual([1, 2, 3]);

    const headers = { authorization: `Bearer ${token}` };
    const full = await fetch(`${harness.baseUrl}/v1/outbox`, { headers });
    expect(full.status).toBe(200);
    const fullBody = await full.json() as { items: Array<{ id: number; prompt: string; createdAt: number }> };
    expect(fullBody.items.map((item) => item.id)).toEqual([1, 2, 3]);
    expect(fullBody.items[0].prompt).toBe('提示词一');
    expect(typeof fullBody.items[0].createdAt).toBe('number');

    const after = await fetch(`${harness.baseUrl}/v1/outbox?after=1`, { headers });
    expect((await after.json() as { items: Array<{ id: number }> }).items.map((item) => item.id)).toEqual([2, 3]);

    const tail = await fetch(`${harness.baseUrl}/v1/outbox?after=3`, { headers });
    expect((await tail.json() as { items: unknown[] }).items).toEqual([]);

    const ack = await fetch(`${harness.baseUrl}/v1/outbox/ack`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [1, 3, 999] }),
    });
    expect(ack.status).toBe(200);
    expect(await ack.json()).toEqual({ acked: 2 });

    const remaining = await fetch(`${harness.baseUrl}/v1/outbox`, { headers });
    expect((await remaining.json() as { items: Array<{ id: number }> }).items.map((item) => item.id)).toEqual([2]);
    expect(harness.service.getOutboxSize()).toBe(1);
  });

  it('requires a bearer token for outbox routes and validates inputs', async () => {
    harness = await startHarness();
    await harness.service.enqueueOutbox('secret prompt');

    const anonymous = await fetch(`${harness.baseUrl}/v1/outbox`);
    expect(anonymous.status).toBe(401);

    const anonymousAck = await fetch(`${harness.baseUrl}/v1/outbox/ack`, {
      method: 'POST',
      body: JSON.stringify({ ids: [1] }),
    });
    expect(anonymousAck.status).toBe(401);

    const token = await pair(harness);
    const headers = { authorization: `Bearer ${token}` };
    const badAfter = await fetch(`${harness.baseUrl}/v1/outbox?after=abc`, { headers });
    expect(badAfter.status).toBe(400);

    const badIds = await fetch(`${harness.baseUrl}/v1/outbox/ack`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ids: ['1'] }),
    });
    expect(badIds.status).toBe(400);

    await expect(harness.service.enqueueOutbox('   ')).rejects.toThrow('empty');
  });

  it('persists the outbox through the injected callbacks and reloads it on start', async () => {
    let stored: Array<{ id: number; prompt: string; createdAt: number }> = [];
    const snapshots: Array<Array<{ id: number }>> = [];
    const crypto = memoryCrypto();
    const service = new ExtensionBridgeService({
      appVersion: '0.3.0',
      port: 0,
      ...crypto,
      loadClients: () => [{
        clientId: 'chrome-1',
        client: 'VESTI Chrome',
        tokenEncrypted: crypto.encrypt('secret-token'),
        pairedAt: Date.now(),
        lastSyncAt: null,
      }],
      saveClients: () => {},
      loadOutbox: () => stored,
      saveOutbox: (items) => {
        snapshots.push(items.map((item) => ({ id: item.id })));
        stored = items.map((item) => ({ ...item }));
      },
      importBundle: async () => IMPORT_COUNTS,
    });
    await service.start();
    const status = service.getStatus();
    const baseUrl = `http://127.0.0.1:${status.port}`;

    await service.enqueueOutbox('持久化的提示词');
    expect(snapshots.length).toBeGreaterThan(0);

    // Restart against the same backing store: the backlog must survive.
    await service.stop();
    const restarted = new ExtensionBridgeService({
      appVersion: '0.3.0',
      port: 0,
      ...crypto,
      loadClients: () => [{
        clientId: 'chrome-1',
        client: 'VESTI Chrome',
        tokenEncrypted: crypto.encrypt('secret-token'),
        pairedAt: Date.now(),
        lastSyncAt: null,
      }],
      saveClients: () => {},
      loadOutbox: () => stored,
      saveOutbox: (items) => {
        stored = items.map((item) => ({ ...item }));
      },
      importBundle: async () => IMPORT_COUNTS,
    });
    await restarted.start();
    try {
      const response = await fetch(`${baseUrl.replace(String(status.port), String(restarted.getStatus().port))}/v1/outbox`, {
        headers: { authorization: 'Bearer secret-token' },
      });
      const body = await response.json() as { items: Array<{ id: number; prompt: string }> };
      expect(body.items).toHaveLength(1);
      expect(body.items[0].prompt).toBe('持久化的提示词');
    } finally {
      await restarted.stop();
    }
  });

  it('caps the outbox backlog, dropping the oldest items', async () => {
    harness = await startHarness();
    for (let index = 0; index < 55; index += 1) {
      await harness.service.enqueueOutbox(`prompt-${index + 1}`);
    }
    expect(harness.service.getOutboxSize()).toBe(50);
    const token = await pair(harness);
    const response = await fetch(`${harness.baseUrl}/v1/outbox`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await response.json() as { items: Array<{ id: number; prompt: string }> };
    expect(body.items).toHaveLength(50);
    expect(body.items[0].prompt).toBe('prompt-6');
    expect(body.items[49].prompt).toBe('prompt-55');
  });
});
