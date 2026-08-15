import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CREDITS_FILE_NAME,
  CreditError,
  CreditService,
  FREE_DAILY_CREDITS,
  MEMBER_MONTHLY_CREDITS,
  creditCost,
  normalizeCrowdfundCode,
  redeemCrowdfundCode,
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

  it('migrates a pre-bonus-pool ledger to bonusCredits: 0', async () => {
    // 奖励池上线前的旧账本没有 bonusCredits 字段,必须能正常读取。
    // cycleAnchor 写成当前周期起点,避免读取时被滚动清零干扰断言。
    const day = new Date(now);
    const cycleStart = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
    await fs.writeFile(
      path.join(directory, CREDITS_FILE_NAME),
      JSON.stringify({ version: 1, cycleAnchor: cycleStart, cycleUsed: 3, lifetimeUsed: 3, entries: [] }),
    );
    const service = createService();
    await service.initialize();

    const balance = service.getBalance('free');
    expect(balance.used).toBe(3);
    expect(balance.remaining).toBe(FREE_DAILY_CREDITS - 3);
  });

  function createService(): CreditService {
    return new CreditService(directory, { now: () => now });
  }
});

describe('CreditService bonus pool (crowdfund grants)', () => {
  let directory: string;
  let now: number;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vesti-credits-bonus-'));
    now = Date.UTC(2026, 2, 15, 9, 0, 0);
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  function createService(): CreditService {
    return new CreditService(directory, { now: () => now });
  }

  it('grantBonus adds credits on top of the cycle allowance and records a grant entry', async () => {
    const service = createService();
    await service.initialize();

    const balance = await service.grantBonus({ tier: 'free', credits: 6_000, label: '众筹兑换 · warm' });

    expect(balance.quota).toBe(FREE_DAILY_CREDITS);
    expect(balance.used).toBe(0);
    expect(balance.remaining).toBe(FREE_DAILY_CREDITS + 6_000);
    expect(balance.recent[0]).toMatchObject({ category: 'grant', credits: 6_000 });

    // 重启后奖励池仍在
    const restarted = createService();
    await restarted.initialize();
    expect(restarted.getBalance('free').remaining).toBe(FREE_DAILY_CREDITS + 6_000);
  });

  it('rejects non-positive bonus grants', async () => {
    const service = createService();
    await service.initialize();

    await expect(service.grantBonus({ tier: 'free', credits: 0, label: 'x' }))
      .rejects.toEqual(expect.objectContaining<Partial<CreditError>>({ code: 'INVALID_REQUEST' }));
    await expect(service.grantBonus({ tier: 'free', credits: 2.5, label: 'x' }))
      .rejects.toEqual(expect.objectContaining<Partial<CreditError>>({ code: 'INVALID_REQUEST' }));
  });

  it('consumes the cycle allowance first, then dips into the bonus pool', async () => {
    const service = createService();
    await service.initialize();
    await service.grantBonus({ tier: 'free', credits: 50, label: 'grant' });

    // 扣完当日 300 周期额度
    for (let index = 0; index < 15; index += 1) {
      await service.consume({ tier: 'free', category: 'image', label: `image-${index}` });
    }
    expect(service.getBalance('free').remaining).toBe(50);

    // 周期额度耗尽后从奖励池扣
    const balance = await service.consume({ tier: 'free', category: 'image', label: 'bonus-image' });
    expect(balance.used).toBe(300); // cycleUsed 不再涨
    expect(balance.remaining).toBe(30);
    expect(balance.lifetimeUsed).toBe(320);

    // 奖励池也耗尽后照旧报 CREDITS_EXHAUSTED
    await service.consume({ tier: 'free', category: 'image', label: 'bonus-image-2' });
    await expect(service.consume({ tier: 'free', category: 'image', label: 'one-too-many' }))
      .rejects.toEqual(expect.objectContaining<Partial<CreditError>>({ code: 'CREDITS_EXHAUSTED' }));
  });

  it('keeps the bonus pool across cycle resets', async () => {
    const service = createService();
    await service.initialize();
    await service.grantBonus({ tier: 'free', credits: 6_000, label: 'grant' });
    await service.consume({ tier: 'free', category: 'image', label: 'today' });

    const nextDay = new Date(now);
    nextDay.setDate(nextDay.getDate() + 1);
    now = nextDay.getTime();

    const rolled = service.getBalance('free');
    expect(rolled.used).toBe(0);
    expect(rolled.remaining).toBe(FREE_DAILY_CREDITS + 6_000);
  });
});

describe('normalizeCrowdfundCode', () => {
  it('normalizes case, whitespace and unicode dashes', () => {
    expect(normalizeCrowdfundCode('  vesti-7k2m-9qxd-4tbn ')).toBe('VESTI-7K2M-9QXD-4TBN');
    expect(normalizeCrowdfundCode('VESTI-7K2M—9QXD–4TBN')).toBe('VESTI-7K2M-9QXD-4TBN');
    expect(normalizeCrowdfundCode('VESTI7K2M9QXD4TBN')).toBe('VESTI-7K2M-9QXD-4TBN');
  });

  it('rejects non-strings and empty input', () => {
    expect(normalizeCrowdfundCode(undefined)).toBeNull();
    expect(normalizeCrowdfundCode(42)).toBeNull();
    expect(normalizeCrowdfundCode('   ')).toBeNull();
  });
});

describe('redeemCrowdfundCode', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vesti-crowdfund-redeem-'));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function createService(): Promise<CreditService> {
    const service = new CreditService(directory);
    await service.initialize();
    return service;
  }

  const context = { tier: 'free' as const, memberSince: null };

  function fetchReturning(status: number, body: unknown) {
    return vi.fn(async () => new Response(JSON.stringify(body), { status }));
  }

  it('rejects malformed codes locally without hitting the network', async () => {
    const service = await createService();
    const fetchImpl = vi.fn();

    const result = await redeemCrowdfundCode(service, 'not-a-code', context, {
      endpoint: 'https://gate.test/v1/crowdfund/redeem',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: false, error: 'invalid_code' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('redeems a valid code: posts it to the gateway and grants the credits', async () => {
    const service = await createService();
    const fetchImpl = fetchReturning(200, { ok: true, tier: 'warm', credits: 6_000 });

    const result = await redeemCrowdfundCode(service, 'vesti-7k2m 9qxd-4tbn', context, {
      endpoint: 'https://gate.test/v1/crowdfund/redeem',
      token: 'test-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [endpoint, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(endpoint).toBe('https://gate.test/v1/crowdfund/redeem');
    expect((init.headers as Record<string, string>)['x-vesti-service-token']).toBe('test-token');
    expect(JSON.parse(String(init.body))).toEqual({ code: 'VESTI-7K2M-9QXD-4TBN' }); // 已归一化

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tier).toBe('warm');
      expect(result.credits).toBe(6_000);
      expect(result.balance.remaining).toBe(FREE_DAILY_CREDITS + 6_000);
    }
  });

  it('maps invalid_code and already_redeemed responses to their UI errors', async () => {
    const service = await createService();

    const invalid = await redeemCrowdfundCode(service, 'VESTI-7K2M-9QXD-4TBN', context, {
      endpoint: 'https://gate.test/v1/crowdfund/redeem',
      fetchImpl: fetchReturning(400, { error: { message: 'invalid_code' } }) as unknown as typeof fetch,
    });
    expect(invalid).toEqual({ ok: false, error: 'invalid_code' });

    const used = await redeemCrowdfundCode(service, 'VESTI-7K2M-9QXD-4TBN', context, {
      endpoint: 'https://gate.test/v1/crowdfund/redeem',
      fetchImpl: fetchReturning(409, { error: { message: 'already_redeemed' } }) as unknown as typeof fetch,
    });
    expect(used).toEqual({ ok: false, error: 'already_redeemed' });

    // 失败不落账
    expect(service.getBalance('free').remaining).toBe(FREE_DAILY_CREDITS);
  });

  it('maps network failures and unexpected payloads to network_error', async () => {
    const service = await createService();

    const offline = await redeemCrowdfundCode(service, 'VESTI-7K2M-9QXD-4TBN', context, {
      endpoint: 'https://gate.test/v1/crowdfund/redeem',
      fetchImpl: vi.fn(async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
    });
    expect(offline).toEqual({ ok: false, error: 'network_error' });

    const rateLimited = await redeemCrowdfundCode(service, 'VESTI-7K2M-9QXD-4TBN', context, {
      endpoint: 'https://gate.test/v1/crowdfund/redeem',
      fetchImpl: fetchReturning(429, { error: { message: 'rate_limited' } }) as unknown as typeof fetch,
    });
    expect(rateLimited).toEqual({ ok: false, error: 'network_error' });

    const malformed = await redeemCrowdfundCode(service, 'VESTI-7K2M-9QXD-4TBN', context, {
      endpoint: 'https://gate.test/v1/crowdfund/redeem',
      fetchImpl: fetchReturning(200, { ok: true }) as unknown as typeof fetch,
    });
    expect(malformed).toEqual({ ok: false, error: 'network_error' });
  });
});
