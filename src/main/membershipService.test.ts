import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PRIVACY_AGREEMENT_VERSION } from '../shared/contracts';
import {
  BETA_MEMBERSHIP_MONTHS,
  MEMBERSHIP_FILE_NAME,
  MembershipError,
  MembershipService,
  shouldGrantDataContributionGift,
} from './membershipService';

describe('MembershipService', () => {
  let directory: string;
  let now: number;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vesti-membership-'));
    now = Date.UTC(2026, 0, 31, 12, 30, 0);
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('starts unregistered and blocks application access', async () => {
    const service = createService();
    expect(await service.initialize()).toMatchObject({
      state: 'unregistered',
      registered: false,
      canUseApp: false,
      dataContribution: null,
    });
    expect(service.getDataContribution()).toEqual({
      enabled: false,
      consentedAt: null,
      version: null,
    });
    await expect(service.getContributorId()).resolves.toBeNull();
    expect(() => service.requireActiveMember()).toThrowError(
      expect.objectContaining({ code: 'AUTHENTICATION_REQUIRED' }),
    );
  });

  it('registers one account, grants three calendar months, and signs in immediately', async () => {
    const service = createService();
    await service.initialize();

    const status = await service.register({ username: '测试用户', password: 'correct horse battery' }, true);

    expect(status).toMatchObject({
      state: 'active',
      registered: true,
      authenticated: true,
      canUseApp: true,
      username: '测试用户',
      plan: 'beta',
      startedAt: now,
      // January 31 + three calendar months is April 30, not May 1.
      expiresAt: Date.UTC(2026, 3, 30, 12, 30, 0),
      grantedMonths: BETA_MEMBERSHIP_MONTHS,
    });
    expect(status.daysRemaining).toBeGreaterThan(0);
    expect(service.requireActiveMember().username).toBe('测试用户');
  });

  it('stores only a salted scrypt hash and never persists the password', async () => {
    const service = createService();
    await service.initialize();
    const password = 'never-write-this-password';
    await service.register({ username: 'beta-user', password }, true);

    const raw = await fs.readFile(path.join(directory, MEMBERSHIP_FILE_NAME), 'utf8');
    const stored = JSON.parse(raw) as {
      account: { password: { algorithm: string; salt: string; hash: string } };
    };

    expect(raw).not.toContain(password);
    expect(stored.account.password.algorithm).toBe('scrypt-v1');
    expect(Buffer.from(stored.account.password.salt, 'base64')).toHaveLength(16);
    expect(Buffer.from(stored.account.password.hash, 'base64')).toHaveLength(64);
  });

  it('persists the signed-in session across service restarts', async () => {
    const first = createService();
    await first.initialize();
    await first.register({ username: 'Beta.User', password: 'password-123' }, true);

    const restarted = createService();
    expect(await restarted.initialize()).toMatchObject({
      state: 'active',
      authenticated: true,
      username: 'Beta.User',
    });

    await restarted.logout();
    const afterLogout = createService();
    expect(await afterLogout.initialize()).toMatchObject({
      state: 'signed_out',
      authenticated: false,
      canUseApp: false,
    });
  });

  it('validates credentials without leaking whether only one field was wrong', async () => {
    const service = createService();
    await service.initialize();
    await service.register({ username: 'Beta-User', password: 'password-123' }, true);
    await service.logout();

    await expect(service.login({ username: 'other-user', password: 'password-123' }))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await expect(service.login({ username: 'beta-user', password: 'wrong-password' }))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });

    await expect(service.login({ username: 'beta-user', password: 'password-123' }))
      .resolves.toMatchObject({ state: 'active', authenticated: true });
  });

  it('allows only one local registration', async () => {
    const service = createService();
    await service.initialize();
    await service.register({ username: 'first-user', password: 'password-123' }, true);

    await expect(service.register({ username: 'second-user', password: 'password-456' }, true))
      .rejects.toMatchObject({ code: 'ALREADY_REGISTERED' });
  });

  it('marks the membership expired at the exact expiry time and downgrades to the free tier', async () => {
    const service = createService();
    await service.initialize();
    const registered = await service.register({ username: 'beta-user', password: 'password-123' }, true);
    now = registered.expiresAt!;

    expect(service.getStatus()).toMatchObject({
      state: 'expired',
      authenticated: true,
      active: false,
      // Free tier: an expired-but-signed-in account keeps using the app.
      canUseApp: true,
      daysRemaining: 0,
    });
    expect(service.requireActiveMember().username).toBe('beta-user');
  });

  it('rejects malformed account data instead of silently granting access', async () => {
    await fs.writeFile(path.join(directory, MEMBERSHIP_FILE_NAME), '{"version":1,"account":{}}');
    const service = createService();

    await expect(service.initialize()).rejects.toEqual(
      expect.objectContaining<Partial<MembershipError>>({
        name: 'MembershipError',
        code: 'MEMBERSHIP_DATA_CORRUPT',
      }),
    );
  });

  it('validates usernames and password length before writing an account', async () => {
    const service = createService();
    await service.initialize();

    await expect(service.register({ username: '../invalid', password: 'password-123' }, true))
      .rejects.toMatchObject({ code: 'INVALID_USERNAME' });
    await expect(service.register({ username: 'valid-user', password: 'short' }, true))
      .rejects.toMatchObject({ code: 'WEAK_PASSWORD' });
    await expect(fs.access(path.join(directory, MEMBERSHIP_FILE_NAME))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // ---- Data contribution consent (docs/PRIVACY-DATA-CONTRIBUTION.md) ----

  it('registers without data-contribution consent and defaults to opted out', async () => {
    const service = createService();
    await service.initialize();

    const status = await service.register({ username: 'beta-user', password: 'password-123' }, false);

    // Registration succeeds without consent; contribution starts disabled.
    expect(status).toMatchObject({ state: 'active', authenticated: true, canUseApp: true });
    expect(status.dataContribution).toEqual({ enabled: false, consentedAt: null, version: null });
    expect(service.getDataContribution()).toEqual({ enabled: false, consentedAt: null, version: null });
    // The account (and its contributor id) exists like any other.
    expect(await service.getContributorId()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('records consent, agreement version and a contributor id at registration', async () => {
    const service = createService();
    await service.initialize();

    const status = await service.register({ username: 'beta-user', password: 'password-123' }, true);

    expect(status.dataContribution).toEqual({
      enabled: true,
      consentedAt: now,
      version: PRIVACY_AGREEMENT_VERSION,
      // Opting in at registration counts as the first enable (one-time gift).
      giftGranted: true,
    });
    expect(service.getDataContribution()).toEqual(status.dataContribution);
    const contributorId = await service.getContributorId();
    expect(contributorId).toMatch(/^[0-9a-f-]{36}$/);
    // The id is stable across calls and service restarts.
    expect(await service.getContributorId()).toBe(contributorId);
    const restarted = createService();
    await restarted.initialize();
    expect(await restarted.getContributorId()).toBe(contributorId);
  });

  it('migrates pre-contribution accounts to opted-out defaults and backfills the contributor id lazily', async () => {
    const first = createService();
    await first.initialize();
    await first.register({ username: 'beta-user', password: 'password-123' }, true);

    // Simulate a membership.json written before data contribution existed.
    const filePath = path.join(directory, MEMBERSHIP_FILE_NAME);
    const stored = JSON.parse(await fs.readFile(filePath, 'utf8')) as {
      account: Record<string, unknown>;
    };
    delete stored.account.contributorId;
    delete stored.account.dataContribution;
    await fs.writeFile(filePath, JSON.stringify(stored), 'utf8');

    const migrated = createService();
    const status = await migrated.initialize();
    // Existing users never get contribution enabled by default.
    expect(status.dataContribution).toEqual({ enabled: false, consentedAt: null, version: null });
    expect(migrated.getDataContribution()).toEqual({ enabled: false, consentedAt: null, version: null });

    const contributorId = await migrated.getContributorId();
    expect(contributorId).toMatch(/^[0-9a-f-]{36}$/);
    const persisted = JSON.parse(await fs.readFile(filePath, 'utf8')) as {
      account: { contributorId?: string };
    };
    expect(persisted.account.contributorId).toBe(contributorId);
  });

  it('toggles data contribution with fresh consent only when authenticated', async () => {
    const service = createService();
    await service.initialize();
    await service.register({ username: 'beta-user', password: 'password-123' }, true);

    // Signed out: toggling is rejected.
    await service.logout();
    expect(service.getDataContribution()).toEqual({ enabled: false, consentedAt: null, version: null });
    await expect(service.setDataContribution(false)).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });

    await service.login({ username: 'beta-user', password: 'password-123' });
    const disabled = await service.setDataContribution(false);
    // Disabling keeps the original consent record as an audit trail.
    expect(disabled).toEqual({
      enabled: false,
      consentedAt: now,
      version: PRIVACY_AGREEMENT_VERSION,
      giftGranted: true,
    });

    now += 60_000;
    const reenabled = await service.setDataContribution(true);
    // Re-enabling records a fresh consent timestamp and the current version.
    expect(reenabled).toEqual({
      enabled: true,
      consentedAt: now,
      version: PRIVACY_AGREEMENT_VERSION,
      giftGranted: true,
    });

    // The toggle survives a service restart.
    const restarted = createService();
    await restarted.initialize();
    expect(restarted.getDataContribution()).toEqual(reenabled);
  });

  it('marks the one-time gift on the first enable and keeps it across off→on toggles', async () => {
    const service = createService();
    await service.initialize();
    // Register WITHOUT consent: no gift flag yet.
    await service.register({ username: 'beta-user', password: 'password-123' }, false);
    expect(service.getDataContribution()).toEqual({ enabled: false, consentedAt: null, version: null });

    // First enable (Settings flow): marks the gift flag for the ledger grant.
    const firstEnable = await service.setDataContribution(true);
    expect(firstEnable).toEqual({
      enabled: true,
      consentedAt: now,
      version: PRIVACY_AGREEMENT_VERSION,
      giftGranted: true,
    });

    // Off→on again: the flag survives, so the caller never re-grants.
    await service.setDataContribution(false);
    expect(service.getDataContribution().giftGranted).toBe(true);
    const secondEnable = await service.setDataContribution(true);
    expect(secondEnable.giftGranted).toBe(true);
  });

  it('decides the one-time gift exactly once (shouldGrantDataContributionGift)', () => {
    const enabledFirstTime = { enabled: true, consentedAt: 1, version: '1.0', giftGranted: true };
    // Registration with consent (no prior account state).
    expect(shouldGrantDataContributionGift(null, enabledFirstTime)).toBe(true);
    // First enable from an opted-out state without the flag.
    expect(shouldGrantDataContributionGift(
      { enabled: false, consentedAt: null, version: null },
      enabledFirstTime,
    )).toBe(true);
    // Off→on with the flag already persisted: never re-grant.
    expect(shouldGrantDataContributionGift(
      { enabled: false, consentedAt: 1, version: '1.0', giftGranted: true },
      enabledFirstTime,
    )).toBe(false);
    // Disabling never grants.
    expect(shouldGrantDataContributionGift(
      null,
      { enabled: false, consentedAt: null, version: null },
    )).toBe(false);
  });

  function createService(): MembershipService {
    return new MembershipService(directory, { now: () => now });
  }
});
