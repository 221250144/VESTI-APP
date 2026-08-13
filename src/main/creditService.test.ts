import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CREDITS_FILE_NAME,
  CreditError,
  CreditService,
  FREE_DAILY_CREDITS,
  MEMBER_MONTHLY_CREDITS,
  creditCost,
} from './creditService';

// Anchor on the 31st so month math crosses a short February, mirroring the
// membership expiry test's edge case.
const MEMBER_SINCE = Date.UTC(2026, 0, 31, 12, 30, 0);

describe('creditCost', () => {
  it('charges chat by actual tokens with a 1-credit floor', () => {
    expect(creditCost({ category: 'chat', tokens: 2500 })).toBe(3);
    expect(creditCost({ category: 'chat', tokens: 1000 })).toBe(1);
    expect(creditCost({ category: 'chat', tokens: 12 })).toBe(1);
  });

  it('estimates chat tokens from request characters when usage is missing', () => {
    expect(creditCost({ category: 'chat', estimatedChars: 8000 })).toBe(2);
    expect(creditCost({ category: 'chat', estimatedChars: 100 })).toBe(1);
  });

  it('charges flat rates for image and embedding', () => {
    expect(creditCost({ category: 'image' })).toBe(20);
    expect(creditCost({ category: 'embedding' })).toBe(1);
  });
});

describe('CreditService', () => {
  let directory: string;
  let now: number;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vesti-credits-'));
    now = Date.UTC(2026, 2, 15, 9, 0, 0); // Mar 15 2026
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('starts with a full member quota anchored on the membership month', async () => {
    const service = createService();
    await service.initialize();

    const balance = service.getBalance('member', { memberSince: MEMBER_SINCE });

    expect(balance).toMatchObject({
      tier: 'member',
      quota: MEMBER_MONTHLY_CREDITS,
      used: 0,
      remaining: MEMBER_MONTHLY_CREDITS,
      lifetimeUsed: 0,
      recent: [],
    });
    // Jan 31 anchor → current cycle started Feb 28, resets Mar 31.
    expect(balance.resetsAt).toBe(Date.UTC(2026, 2, 31, 12, 30, 0));
  });

  it('starts with a full free quota resetting at local midnight', async () => {
    const service = createService();
    await service.initialize();

    const balance = service.getBalance('free');

    expect(balance.quota).toBe(FREE_DAILY_CREDITS);
    expect(balance.remaining).toBe(FREE_DAILY_CREDITS);
    const day = new Date(now);
    expect(balance.resetsAt).toBe(
      new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime(),
    );
  });

  it('consumes chat credits from usage tokens and records the entry', async () => {
    const service = createService();
    await service.initialize();

    const balance = await service.consume({
      tier: 'member',
      memberSince: MEMBER_SINCE,
      category: 'chat',
      tokens: 2500,
      label: 'explore · test',
    });

    expect(balance.used).toBe(3);
    expect(balance.remaining).toBe(MEMBER_MONTHLY_CREDITS - 3);
    expect(balance.lifetimeUsed).toBe(3);
    expect(balance.recent[0]).toMatchObject({ category: 'chat', credits: 3, label: 'explore · test' });

    const raw = JSON.parse(await fs.readFile(path.join(directory, CREDITS_FILE_NAME), 'utf8')) as {
      cycleUsed: number;
    };
    expect(raw.cycleUsed).toBe(3);
  });

  it('falls back to character estimates when usage is absent', async () => {
    const service = createService();
    await service.initialize();

    const balance = await service.consume({
      tier: 'free',
      category: 'chat',
      estimatedChars: 8000,
      label: 'no-usage',
    });

    expect(balance.used).toBe(2);
  });

  it('charges flat rates for image and embedding categories', async () => {
    const service = createService();
    await service.initialize();

    await service.consume({ tier: 'free', category: 'image', label: 'image' });
    const balance = await service.consume({ tier: 'free', category: 'embedding', label: 'embed' });

    expect(balance.used).toBe(21);
  });

  it('peeks without deducting', async () => {
    const service = createService();
    await service.initialize();

    const peeked = service.peek({ tier: 'free', category: 'image', label: 'image' });
    expect(peeked.cost).toBe(20);
    expect(peeked.balance.remaining).toBe(FREE_DAILY_CREDITS);
    expect(service.getBalance('free').remaining).toBe(FREE_DAILY_CREDITS);
  });

  it('throws CREDITS_EXHAUSTED when the cycle cannot cover a call', async () => {
    const service = createService();
    await service.initialize();
    for (let index = 0; index < 15; index += 1) {
      await service.consume({ tier: 'free', category: 'image', label: `image-${index}` });
    }

    await expect(service.consume({ tier: 'free', category: 'image', label: 'one-too-many' }))
      .rejects.toEqual(expect.objectContaining<Partial<CreditError>>({ code: 'CREDITS_EXHAUSTED' }));
    // A failed consume must not have deducted anything.
    expect(service.getBalance('free').used).toBe(300);
    // Peeking still works and reports the floor cost.
    expect(service.peek({ tier: 'free', category: 'chat', label: 'chat' }).cost).toBe(1);
  });

  it('rolls the member cycle on the anchor day', async () => {
    const service = createService();
    await service.initialize();
    await service.consume({
      tier: 'member',
      memberSince: MEMBER_SINCE,
      category: 'chat',
      tokens: 5000,
      label: 'before-reset',
    });
    expect(service.getBalance('member', { memberSince: MEMBER_SINCE }).used).toBe(5);

    // Jump past the Mar 31 reset: the new cycle starts fresh, lifetime stays.
    now = Date.UTC(2026, 3, 1, 0, 0, 0);
    const rolled = service.getBalance('member', { memberSince: MEMBER_SINCE });
    expect(rolled.used).toBe(0);
    expect(rolled.lifetimeUsed).toBe(5);
    expect(rolled.resetsAt).toBe(Date.UTC(2026, 3, 30, 12, 30, 0));
    expect(rolled.recent).toHaveLength(1);
  });

  it('rolls the free cycle at local midnight', async () => {
    const service = createService();
    await service.initialize();
    await service.consume({ tier: 'free', category: 'embedding', label: 'today' });

    const nextDay = new Date(now);
    nextDay.setDate(nextDay.getDate() + 1);
    now = nextDay.getTime();

    const rolled = service.getBalance('free');
    expect(rolled.used).toBe(0);
    expect(rolled.lifetimeUsed).toBe(1);
  });

  it('persists the ledger across service restarts', async () => {
    const first = createService();
    await first.initialize();
    await first.consume({ tier: 'free', category: 'chat', tokens: 1500, label: 'persisted' });

    const restarted = createService();
    await restarted.initialize();
    const balance = restarted.getBalance('free');
    expect(balance.used).toBe(2);
    expect(balance.recent[0]).toMatchObject({ label: 'persisted' });
  });

  it('recovers from a corrupt ledger file instead of failing', async () => {
    await fs.writeFile(path.join(directory, CREDITS_FILE_NAME), '{"version":1,"cycleUsed":"oops"}');
    const service = createService();
    await service.initialize();

    const balance = service.getBalance('free');
    expect(balance.used).toBe(0);
    expect(balance.remaining).toBe(FREE_DAILY_CREDITS);
  });

  it('caps the ledger at 200 entries and serves the newest 20', async () => {
    const service = createService();
    await service.initialize();
    for (let index = 0; index < 205; index += 1) {
      // 1 credit each, staying under the free daily cap is impossible — use member.
      await service.consume({
        tier: 'member',
        memberSince: MEMBER_SINCE,
        category: 'embedding',
        label: `entry-${index}`,
      });
    }

    const raw = JSON.parse(await fs.readFile(path.join(directory, CREDITS_FILE_NAME), 'utf8')) as {
      entries: Array<{ label: string }>;
    };
    expect(raw.entries).toHaveLength(200);
    expect(raw.entries[0]!.label).toBe('entry-204');
    expect(raw.entries.at(-1)!.label).toBe('entry-5');

    const balance = service.getBalance('member', { memberSince: MEMBER_SINCE });
    expect(balance.recent).toHaveLength(20);
    expect(balance.recent[0]!.label).toBe('entry-204');
    expect(balance.recent.at(-1)!.label).toBe('entry-185');
    expect(balance.used).toBe(205);
  });

  function createService(): CreditService {
    return new CreditService(directory, { now: () => now });
  }
});
