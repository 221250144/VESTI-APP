import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BETA_MEMBERSHIP_MONTHS,
  MEMBERSHIP_FILE_NAME,
  MembershipError,
  MembershipService,
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
    });
    expect(() => service.requireActiveMember()).toThrowError(
      expect.objectContaining({ code: 'AUTHENTICATION_REQUIRED' }),
    );
  });

  it('registers one account, grants three calendar months, and signs in immediately', async () => {
    const service = createService();
    await service.initialize();

    const status = await service.register({ username: '测试用户', password: 'correct horse battery' });

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
    await service.register({ username: 'beta-user', password });

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
    await first.register({ username: 'Beta.User', password: 'password-123' });

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
    await service.register({ username: 'Beta-User', password: 'password-123' });
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
    await service.register({ username: 'first-user', password: 'password-123' });

    await expect(service.register({ username: 'second-user', password: 'password-456' }))
      .rejects.toMatchObject({ code: 'ALREADY_REGISTERED' });
  });

  it('marks the membership expired at the exact expiry time and downgrades to the free tier', async () => {
    const service = createService();
    await service.initialize();
    const registered = await service.register({ username: 'beta-user', password: 'password-123' });
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

    await expect(service.register({ username: '../invalid', password: 'password-123' }))
      .rejects.toMatchObject({ code: 'INVALID_USERNAME' });
    await expect(service.register({ username: 'valid-user', password: 'short' }))
      .rejects.toMatchObject({ code: 'WEAK_PASSWORD' });
    await expect(fs.access(path.join(directory, MEMBERSHIP_FILE_NAME))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  function createService(): MembershipService {
    return new MembershipService(directory, { now: () => now });
  }
});
