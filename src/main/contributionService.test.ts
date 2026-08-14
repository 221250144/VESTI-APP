// contributionService: consent-gated, incrementally-uploaded RL data
// contribution. Fakes cover the capture source, membership consent gate and
// fetch; the persisted state file drives incremental behavior across rounds.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ConversationExportBundle,
  DataContributionState,
  VestiConversationRecord,
  VestiMessageRecord,
} from '../shared/contracts';
import { computeBundleFingerprint } from '../shared/exportFingerprint';
import {
  CONTRIBUTION_BATCH_SIZE,
  ContributionService,
  type ContributionServiceOptions,
} from './contributionService';
import { DEMO_SERVICE_TOKEN } from './settingsService';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value, 'utf8')),
    decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
  },
}));

const OPTED_IN: DataContributionState = { enabled: true, consentedAt: 1_000, version: '1.0' };
const OPTED_OUT: DataContributionState = { enabled: false, consentedAt: null, version: null };

function makeConversation(sessionId: string, overrides: Partial<VestiConversationRecord> = {}): VestiConversationRecord {
  return {
    id: 1,
    uuid: `uuid-${sessionId}`,
    platform: 'kimi-code',
    title: `Session ${sessionId}`,
    snippet: `snippet of ${sessionId}`,
    url: '',
    source_created_at: 1_000,
    first_captured_at: 1_000,
    last_captured_at: 2_000,
    created_at: 1_000,
    updated_at: 2_000,
    message_count: 1,
    turn_count: 1,
    is_archived: false,
    is_trash: false,
    tags: [],
    topic_id: null,
    is_starred: false,
    _source: 'local_terminal',
    _cli_id: sessionId,
    _cli_platform: 'kimi-code',
    ...overrides,
  };
}

function makeMessage(sessionId: string, text: string, overrides: Partial<VestiMessageRecord> = {}): VestiMessageRecord {
  return {
    id: 1,
    conversation_id: 1,
    role: 'user',
    content_text: text,
    content_ast: null,
    content_ast_version: null,
    degraded_nodes_count: 0,
    citations: [],
    attachments: [],
    artifacts: [],
    normalized_html_snapshot: null,
    created_at: 1_500,
    _source: 'local_terminal',
    ...overrides,
  };
}

/** `updatedAt` and the (length-varying) text both feed the bundle fingerprint. */
function makeBundle(sessionId: string, text = `hello from ${sessionId}`, updatedAt = 2_000): ConversationExportBundle {
  return {
    conversation: makeConversation(sessionId, { updated_at: updatedAt }),
    messages: [makeMessage(sessionId, text)],
  };
}

describe('ContributionService', () => {
  let directory: string;
  let stateFilePath: string;
  let bundles: ConversationExportBundle[];
  let consent: DataContributionState;
  let contributorId: string | null;
  let now: number;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vesti-contribution-'));
    stateFilePath = path.join(directory, 'contribution-state.json');
    bundles = [];
    consent = OPTED_IN;
    contributorId = 'contributor-0001';
    now = 10_000;
    fetchMock = vi.fn();
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  function createService(options: Partial<ContributionServiceOptions> = {}): ContributionService {
    return new ContributionService({
      captureService: { exportAllConversationBundles: () => bundles },
      membershipService: {
        getDataContribution: () => consent,
        getContributorId: async () => contributorId,
      },
      stateFilePath,
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => now,
      ...options,
    });
  }

  async function readState(): Promise<{
    uploaded: Record<string, number>;
    excluded: Record<string, number>;
    pending: ConversationExportBundle[];
  }> {
    return JSON.parse(await fs.readFile(stateFilePath, 'utf8'));
  }

  function uploadedSessionIds(callIndex: number): string[] {
    const body = JSON.parse(fetchMock.mock.calls[callIndex][1].body as string) as {
      contributorId: string;
      sessions: ConversationExportBundle[];
    };
    return body.sessions.map(session => session.conversation._cli_id);
  }

  it('posts consent-gated bundles to the gateway collect endpoint with the service token', async () => {
    bundles = [makeBundle('s1'), makeBundle('s2')];
    const service = createService();

    await service.runOnce();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    // The default demo base ends in /api; the collect endpoint lives on /v1.
    expect(url).toBe('https://vesti.world/gate/v1/collect/sessions');
    expect(init.headers['x-vesti-service-token']).toBe(DEMO_SERVICE_TOKEN);
    expect(JSON.parse(init.body).contributorId).toBe('contributor-0001');
    expect(uploadedSessionIds(0)).toEqual(['s1', 's2']);
    const state = await readState();
    expect(state.pending).toEqual([]);
    expect(Object.keys(state.uploaded).sort()).toEqual(['s1', 's2']);
    expect(state.uploaded.s1).toBe(computeBundleFingerprint(bundles[0].conversation, bundles[0].messages));
  });

  it('maps a custom /api gateway base onto /v1 like the chat endpoints', async () => {
    bundles = [makeBundle('s1')];
    const service = createService({ gatewayBase: 'https://example.com/gate/api/', token: 'tok-1' });

    await service.runOnce();

    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://example.com/gate/v1/collect/sessions');
    expect(init.headers['x-vesti-service-token']).toBe('tok-1');
  });

  it('stays silent while consent is off and drops any persisted pending queue', async () => {
    consent = OPTED_OUT;
    bundles = [makeBundle('s1')];
    // A leftover queue from an earlier opted-in round must be wiped, not held.
    await fs.writeFile(stateFilePath, JSON.stringify({
      uploaded: {},
      excluded: {},
      pending: [makeBundle('stale')],
    }), 'utf8');
    const service = createService();

    await service.runOnce();

    expect(fetchMock).not.toHaveBeenCalled();
    expect((await readState()).pending).toEqual([]);
  });

  it('uploads only sessions whose fingerprint moved since the last round', async () => {
    bundles = [makeBundle('s1'), makeBundle('s2')];
    const service = createService();
    await service.runOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // s1 unchanged, s2 edited (new text + updated_at), s3 brand new.
    bundles = [
      makeBundle('s1'),
      makeBundle('s2', 'a longer, edited body for s2', 3_000),
      makeBundle('s3'),
    ];
    await service.runOnce();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(uploadedSessionIds(1)).toEqual(['s2', 's3']);
  });

  it('excludes PII-hit sessions whole and never retries them while unchanged', async () => {
    bundles = [makeBundle('pii', 'call me at 13812345678'), makeBundle('clean')];
    const service = createService();

    await service.runOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(uploadedSessionIds(0)).toEqual(['clean']);
    let state = await readState();
    expect(Object.keys(state.excluded)).toEqual(['pii']);
    expect(state.uploaded.pii).toBeUndefined();

    // Same content: the excluded entry is not re-scanned or re-uploaded.
    await service.runOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Content moves but still hits PII: re-checked, still excluded.
    bundles = [makeBundle('pii', 'email a@b.co instead', 3_000), makeBundle('clean')];
    await service.runOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    state = await readState();
    expect(state.uploaded.pii).toBeUndefined();

    // Once the content is clean, the session becomes uploadable again.
    bundles = [makeBundle('pii', 'all cleaned up now', 4_000), makeBundle('clean')];
    await service.runOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(uploadedSessionIds(1)).toEqual(['pii']);
  });

  it('keeps a failed batch pending for the next round and stamps uploaded only on success', async () => {
    bundles = [makeBundle('s1'), makeBundle('s2')];
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    const service = createService();

    await expect(service.runOnce()).resolves.toBeUndefined(); // silent failure
    let state = await readState();
    expect(state.uploaded).toEqual({});
    expect(state.pending.map(bundle => bundle.conversation._cli_id)).toEqual(['s1', 's2']);

    await service.runOnce(); // fetch is healthy again
    expect(fetchMock).toHaveBeenCalledTimes(2);
    state = await readState();
    expect(state.pending).toEqual([]);
    expect(Object.keys(state.uploaded).sort()).toEqual(['s1', 's2']);
  });

  it(`splits the queue into batches of at most ${CONTRIBUTION_BATCH_SIZE} sessions`, async () => {
    const total = CONTRIBUTION_BATCH_SIZE + 5;
    bundles = Array.from({ length: total }, (_value, index) => makeBundle(`s${index}`));
    const service = createService();

    await service.runOnce();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(uploadedSessionIds(0)).toHaveLength(CONTRIBUTION_BATCH_SIZE);
    expect(uploadedSessionIds(1)).toHaveLength(5);
    const state = await readState();
    expect(state.pending).toEqual([]);
    expect(Object.keys(state.uploaded)).toHaveLength(total);
  });

  it('keeps later batches pending when an earlier batch fails mid-round', async () => {
    const total = CONTRIBUTION_BATCH_SIZE + 5;
    bundles = Array.from({ length: total }, (_value, index) => makeBundle(`s${index}`));
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: false, status: 500 });
    const service = createService();

    await service.runOnce();

    let state = await readState();
    expect(Object.keys(state.uploaded)).toHaveLength(CONTRIBUTION_BATCH_SIZE);
    expect(state.pending).toHaveLength(5);

    await service.runOnce(); // retry with a healthy endpoint
    state = await readState();
    expect(state.pending).toEqual([]);
    expect(Object.keys(state.uploaded)).toHaveLength(total);
  });

  it('replaces a queued snapshot when the session changes again before upload', async () => {
    bundles = [makeBundle('s1', 'version one')];
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    const service = createService();
    await service.runOnce();

    bundles = [makeBundle('s1', 'version two — edited', 3_000)];
    await service.runOnce();

    // One fetch per round, and the second round ships only the newest snapshot.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = JSON.parse(fetchMock.mock.calls[1][1].body as string) as {
      sessions: ConversationExportBundle[];
    };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].messages[0].content_text).toBe('version two — edited');
  });

  it('never rejects a round, even when the capture source throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failing = new ContributionService({
      captureService: {
        exportAllConversationBundles: () => {
          throw new Error('db locked');
        },
      },
      membershipService: {
        getDataContribution: () => consent,
        getContributorId: async () => contributorId,
      },
      stateFilePath,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(failing.runOnce()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('runs on a delayed-then-interval schedule and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      bundles = [makeBundle('s1')];
      const service = createService({ initialDelayMs: 1_000, intervalMs: 5_000 });
      service.start();

      await vi.advanceTimersByTimeAsync(999);
      expect(fetchMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      // The interval round only ships sessions that changed since round one.
      bundles = [makeBundle('s1'), makeBundle('s2')];
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(uploadedSessionIds(1)).toEqual(['s2']);

      service.stop();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('debounces capture-sync triggers into a single round', async () => {
    vi.useFakeTimers();
    try {
      bundles = [makeBundle('s1')];
      const service = createService({ requestDebounceMs: 500 });
      service.requestRun();
      service.requestRun();
      service.requestRun();

      await vi.advanceTimersByTimeAsync(500);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      service.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
