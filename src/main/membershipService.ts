import { randomBytes, randomUUID, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { PRIVACY_AGREEMENT_VERSION, type DataContributionState } from '../shared/contracts';

const scrypt = promisify(nodeScrypt);

export const MEMBERSHIP_FILE_NAME = 'membership.json';
export const BETA_MEMBERSHIP_MONTHS = 3 as const;

const PASSWORD_KEY_LENGTH = 64;
const PASSWORD_SALT_LENGTH = 16;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 256;
const MIN_USERNAME_LENGTH = 3;
const MAX_USERNAME_LENGTH = 32;

export type MembershipState = 'unregistered' | 'signed_out' | 'active' | 'expired';

export type MembershipErrorCode =
  | 'NOT_INITIALIZED'
  | 'ALREADY_REGISTERED'
  | 'CONSENT_REQUIRED'
  | 'INVALID_USERNAME'
  | 'WEAK_PASSWORD'
  | 'NOT_REGISTERED'
  | 'INVALID_CREDENTIALS'
  | 'AUTHENTICATION_REQUIRED'
  | 'MEMBERSHIP_EXPIRED'
  | 'MEMBERSHIP_DATA_CORRUPT';

export interface MembershipCredentials {
  username: string;
  password: string;
}

export interface MembershipStatus {
  state: MembershipState;
  registered: boolean;
  authenticated: boolean;
  active: boolean;
  canUseApp: boolean;
  username: string | null;
  plan: 'beta' | null;
  memberSince: number | null;
  createdAt: number | null;
  startedAt: number | null;
  expiresAt: number | null;
  grantedMonths: typeof BETA_MEMBERSHIP_MONTHS | null;
  daysRemaining: number;
  /** Effective data-contribution consent; null when no account exists. */
  dataContribution: DataContributionState | null;
}

/** Opted-out baseline: pre-contribution accounts and signed-out state. */
const DATA_CONTRIBUTION_DISABLED: DataContributionState = {
  enabled: false,
  consentedAt: null,
  version: null,
};

export interface MembershipServiceOptions {
  /** Injectable clock keeps expiry behavior deterministic in tests. */
  now?: () => number;
}

interface StoredPassword {
  algorithm: 'scrypt-v1';
  salt: string;
  hash: string;
  keyLength: typeof PASSWORD_KEY_LENGTH;
}

interface StoredMembership {
  plan: 'beta';
  startedAt: number;
  expiresAt: number;
  grantedMonths: typeof BETA_MEMBERSHIP_MONTHS;
}

interface StoredSession {
  id: string;
  authenticatedAt: number;
}

interface StoredAccount {
  username: string;
  normalizedUsername: string;
  password: StoredPassword;
  createdAt: number;
  membership: StoredMembership;
  session: StoredSession | null;
  /** Anonymous RL-data contributor id. Generated at registration; accounts
   * created before data contribution get one lazily via getContributorId(). */
  contributorId?: string;
  /** Absent in pre-contribution membership.json files — treated as opted out. */
  dataContribution?: DataContributionState;
}

interface StoredMembershipFile {
  version: 1;
  account: StoredAccount;
}

export class MembershipError extends Error {
  constructor(
    public readonly code: MembershipErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MembershipError';
  }
}

/**
 * Local-only Beta membership store.
 *
 * This is deliberately isolated from application settings so the renderer can
 * never receive password material. It is suitable for the offline Beta gate,
 * but is not a replacement for server-issued entitlements once paid plans are
 * introduced: a user with filesystem access can modify local application data.
 */
export class MembershipService {
  private readonly filePath: string;
  private readonly now: () => number;
  private account: StoredAccount | null = null;
  private initialized = false;
  private mutation = Promise.resolve();

  constructor(userDataDirectory: string, options: MembershipServiceOptions = {}) {
    this.filePath = path.join(userDataDirectory, MEMBERSHIP_FILE_NAME);
    this.now = options.now ?? Date.now;
  }

  async initialize(): Promise<MembershipStatus> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      this.account = migrateStoredAccount(this.parseStoredFile(raw).account);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.account = null;
      } else if (error instanceof MembershipError) {
        throw error;
      } else {
        throw new MembershipError(
          'MEMBERSHIP_DATA_CORRUPT',
          'The local membership file cannot be read.',
        );
      }
    }
    this.initialized = true;
    return this.getStatus();
  }

  getStatus(): MembershipStatus {
    this.assertInitialized();
    if (!this.account) {
      return {
        state: 'unregistered',
        registered: false,
        authenticated: false,
        active: false,
        canUseApp: false,
        username: null,
        plan: null,
        memberSince: null,
        createdAt: null,
        startedAt: null,
        expiresAt: null,
        grantedMonths: null,
        daysRemaining: 0,
        dataContribution: null,
      };
    }

    const authenticated = this.account.session !== null;
    const active = this.now() < this.account.membership.expiresAt;
    const state: MembershipState = !authenticated
      ? 'signed_out'
      : active
        ? 'active'
        : 'expired';

    return {
      state,
      registered: true,
      authenticated,
      active,
      // Expiry downgrades the account to the free tier instead of locking the
      // product: any signed-in account may use the app; `active` remains the
      // member/free tier discriminator.
      canUseApp: authenticated,
      username: this.account.username,
      plan: this.account.membership.plan,
      memberSince: this.account.membership.startedAt,
      createdAt: this.account.createdAt,
      startedAt: this.account.membership.startedAt,
      expiresAt: this.account.membership.expiresAt,
      grantedMonths: this.account.membership.grantedMonths,
      daysRemaining: active
        ? Math.max(1, Math.ceil((this.account.membership.expiresAt - this.now()) / 86_400_000))
        : 0,
      dataContribution: this.getDataContribution(),
    };
  }

  async register(credentials: MembershipCredentials, dataConsent: boolean): Promise<MembershipStatus> {
    return this.runMutation(async () => {
      this.assertInitialized();
      if (this.account) {
        throw new MembershipError(
          'ALREADY_REGISTERED',
          'A local Vesti account has already been registered.',
        );
      }
      // Data contribution is opt-in and decoupled from registration: consent
      // recorded only when the user explicitly checked the box; otherwise the
      // account starts opted out and can enable it later in Settings.
      const username = this.validateUsername(credentials.username);
      this.validatePassword(credentials.password);
      const startedAt = this.now();
      const salt = randomBytes(PASSWORD_SALT_LENGTH);
      const hash = await this.derivePassword(credentials.password, salt);

      this.account = {
        username,
        normalizedUsername: normalizeUsername(username),
        password: {
          algorithm: 'scrypt-v1',
          salt: salt.toString('base64'),
          hash: hash.toString('base64'),
          keyLength: PASSWORD_KEY_LENGTH,
        },
        createdAt: startedAt,
        membership: {
          plan: 'beta',
          startedAt,
          expiresAt: addUtcCalendarMonths(startedAt, BETA_MEMBERSHIP_MONTHS),
          grantedMonths: BETA_MEMBERSHIP_MONTHS,
        },
        session: this.createSession(startedAt),
        contributorId: randomUUID(),
        // Opting in at registration counts as the first enable: the one-time
        // credit gift is marked here and granted by the caller (main.ts)
        // through the shared credit ledger.
        dataContribution: dataConsent === true
          ? {
              enabled: true,
              consentedAt: startedAt,
              version: PRIVACY_AGREEMENT_VERSION,
              giftGranted: true,
            }
          : { ...DATA_CONTRIBUTION_DISABLED },
      };

      try {
        await this.persist();
      } catch (error) {
        this.account = null;
        throw error;
      }
      return this.getStatus();
    });
  }

  async login(credentials: MembershipCredentials): Promise<MembershipStatus> {
    return this.runMutation(async () => {
      this.assertInitialized();
      if (!this.account) {
        throw new MembershipError('NOT_REGISTERED', 'No local Vesti account is registered.');
      }

      const normalizedUsername = normalizeUsername(credentials.username);
      const usernameMatches = normalizedUsername === this.account.normalizedUsername;
      const salt = Buffer.from(this.account.password.salt, 'base64');
      const actualHash = await this.derivePassword(credentials.password, salt);
      const expectedHash = Buffer.from(this.account.password.hash, 'base64');
      const passwordMatches = actualHash.length === expectedHash.length
        && timingSafeEqual(actualHash, expectedHash);

      if (!usernameMatches || !passwordMatches) {
        throw new MembershipError('INVALID_CREDENTIALS', 'The username or password is incorrect.');
      }

      const previousSession = this.account.session;
      this.account.session = this.createSession(this.now());
      try {
        await this.persist();
      } catch (error) {
        this.account.session = previousSession;
        throw error;
      }
      return this.getStatus();
    });
  }

  async logout(): Promise<MembershipStatus> {
    return this.runMutation(async () => {
      this.assertInitialized();
      if (!this.account || !this.account.session) return this.getStatus();

      const previousSession = this.account.session;
      this.account.session = null;
      try {
        await this.persist();
      } catch (error) {
        this.account.session = previousSession;
        throw error;
      }
      return this.getStatus();
    });
  }

  /**
   * Effective data-contribution consent. Unregistered or signed-out state
   * always reports disabled, so the contribution uploader stays silent until
   * an authenticated account has explicitly opted in.
   */
  getDataContribution(): DataContributionState {
    this.assertInitialized();
    if (!this.account || !this.account.session) return { ...DATA_CONTRIBUTION_DISABLED };
    return { ...(this.account.dataContribution ?? DATA_CONTRIBUTION_DISABLED) };
  }

  /**
   * Toggle RL data contribution (requires an authenticated account). Enabling
   * records a fresh consent timestamp and the current agreement version, and
   * marks the one-time opt-in credit gift as granted (the caller grants the
   * credits via the shared ledger — see shouldGrantDataContributionGift);
   * disabling keeps the last consent record as an audit trail but stops all
   * uploads.
   */
  async setDataContribution(enabled: boolean): Promise<DataContributionState> {
    return this.runMutation(async () => {
      this.requireActiveMember();
      const account = this.account;
      if (!account) {
        throw new MembershipError('NOT_REGISTERED', 'No local Vesti account is registered.');
      }
      const previous = account.dataContribution;
      account.dataContribution = enabled
        ? {
            enabled: true,
            consentedAt: this.now(),
            version: PRIVACY_AGREEMENT_VERSION,
            // First-ever enable marks the gift; later re-enables keep the flag.
            giftGranted: true,
          }
        : {
            enabled: false,
            consentedAt: previous?.consentedAt ?? null,
            version: previous?.version ?? null,
            // The gift flag survives opt-out so off→on never re-grants.
            ...(previous?.giftGranted === true ? { giftGranted: true } : {}),
          };
      try {
        await this.persist();
      } catch (error) {
        account.dataContribution = previous;
        throw error;
      }
      return this.getDataContribution();
    });
  }

  /**
   * Anonymous contributor id for the RL-data upload. Generated at
   * registration; pre-contribution accounts get one lazily here, persisted so
   * the id stays stable across restarts.
   */
  async getContributorId(): Promise<string | null> {
    return this.runMutation(async () => {
      this.assertInitialized();
      if (!this.account) return null;
      if (typeof this.account.contributorId === 'string' && this.account.contributorId) {
        return this.account.contributorId;
      }
      const generated = randomUUID();
      this.account.contributorId = generated;
      try {
        await this.persist();
      } catch (error) {
        delete this.account.contributorId;
        throw error;
      }
      return generated;
    });
  }

  requireActiveMember(): MembershipStatus {
    const status = this.getStatus();
    if (!status.authenticated) {
      throw new MembershipError(
        'AUTHENTICATION_REQUIRED',
        'Sign in with an active Vesti membership to continue.',
      );
    }
    // With free-tier downgrade, canUseApp === authenticated, so this branch
    // no longer fires for expired accounts; kept as a guard should the
    // access semantics tighten again.
    if (!status.canUseApp) {
      throw new MembershipError('MEMBERSHIP_EXPIRED', 'The local Vesti membership has expired.');
    }
    return status;
  }

  /** Stable gate name used by main-process IPC handlers. */
  requireActive(): MembershipStatus {
    return this.requireActiveMember();
  }

  isActive(): boolean {
    return this.getStatus().canUseApp;
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new MembershipError('NOT_INITIALIZED', 'MembershipService has not been initialized.');
    }
  }

  private validateUsername(value: string): string {
    const username = typeof value === 'string' ? value.trim().normalize('NFKC') : '';
    const length = [...username].length;
    if (
      length < MIN_USERNAME_LENGTH
      || length > MAX_USERNAME_LENGTH
      || !/^[\p{L}\p{N}](?:[\p{L}\p{N}._-]*[\p{L}\p{N}])?$/u.test(username)
    ) {
      throw new MembershipError(
        'INVALID_USERNAME',
        'Username must be 3-32 letters or numbers and may contain ., _ or -.',
      );
    }
    return username;
  }

  private validatePassword(value: string): void {
    if (
      typeof value !== 'string'
      || value.length < MIN_PASSWORD_LENGTH
      || value.length > MAX_PASSWORD_LENGTH
    ) {
      throw new MembershipError(
        'WEAK_PASSWORD',
        'Password must contain between 8 and 256 characters.',
      );
    }
  }

  private async derivePassword(password: string, salt: Buffer): Promise<Buffer> {
    return (await scrypt(password, salt, PASSWORD_KEY_LENGTH)) as Buffer;
  }

  private createSession(authenticatedAt: number): StoredSession {
    return {
      id: randomBytes(32).toString('base64url'),
      authenticatedAt,
    };
  }

  private parseStoredFile(raw: string): StoredMembershipFile {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new MembershipError('MEMBERSHIP_DATA_CORRUPT', 'The local membership file is invalid JSON.');
    }
    if (!isValidStoredMembershipFile(value)) {
      throw new MembershipError('MEMBERSHIP_DATA_CORRUPT', 'The local membership file has an invalid format.');
    }
    return value;
  }

  private async persist(): Promise<void> {
    if (!this.account) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const payload: StoredMembershipFile = { version: 1, account: this.account };
    try {
      await fs.writeFile(temporaryPath, JSON.stringify(payload, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      try {
        await fs.rename(temporaryPath, this.filePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!['EEXIST', 'EPERM'].includes(code ?? '')) throw error;
        // Windows may refuse replacing an existing destination via rename.
        await fs.rm(this.filePath, { force: true });
        await fs.rename(temporaryPath, this.filePath);
      }
    } finally {
      await fs.rm(temporaryPath, { force: true });
    }
  }

  private async runMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutation;
    let release!: () => void;
    this.mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function normalizeUsername(value: string): string {
  return typeof value === 'string' ? value.trim().normalize('NFKC').toLocaleLowerCase('en-US') : '';
}

/**
 * One-time opt-in credit gift decision. `before` is the effective consent
 * state captured immediately before the enable mutation (null when no account
 * existed, e.g. at registration); `after` is the state the mutation produced.
 * True exactly once per account: on the first enable that finds no persisted
 * giftGranted flag. The flag itself is persisted atomically with the enable
 * (see setDataContribution/register), so off→on toggles never re-grant.
 */
export function shouldGrantDataContributionGift(
  before: DataContributionState | null,
  after: DataContributionState,
): boolean {
  return after.enabled === true && before?.giftGranted !== true;
}

/** Exported for CreditService's member-cycle anchoring (same month math). */
export function addUtcCalendarMonths(timestamp: number, months: number): number {
  const source = new Date(timestamp);
  const absoluteMonth = source.getUTCFullYear() * 12 + source.getUTCMonth() + months;
  const year = Math.floor(absoluteMonth / 12);
  const month = ((absoluteMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(
    year,
    month,
    Math.min(source.getUTCDate(), lastDay),
    source.getUTCHours(),
    source.getUTCMinutes(),
    source.getUTCSeconds(),
    source.getUTCMilliseconds(),
  );
}

function isValidStoredMembershipFile(value: unknown): value is StoredMembershipFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.account)) return false;
  const account = value.account;
  if (
    typeof account.username !== 'string'
    || typeof account.normalizedUsername !== 'string'
    || normalizeUsername(account.username) !== account.normalizedUsername
    || !isFiniteTimestamp(account.createdAt)
    || !isRecord(account.password)
    || account.password.algorithm !== 'scrypt-v1'
    || account.password.keyLength !== PASSWORD_KEY_LENGTH
    || !isBase64OfLength(account.password.salt, PASSWORD_SALT_LENGTH)
    || !isBase64OfLength(account.password.hash, PASSWORD_KEY_LENGTH)
    || !isRecord(account.membership)
    || account.membership.plan !== 'beta'
    || account.membership.grantedMonths !== BETA_MEMBERSHIP_MONTHS
    || !isFiniteTimestamp(account.membership.startedAt)
    || !isFiniteTimestamp(account.membership.expiresAt)
    || account.membership.expiresAt <= account.membership.startedAt
  ) {
    return false;
  }
  if (account.session === null) return true;
  return isRecord(account.session)
    && typeof account.session.id === 'string'
    && /^[A-Za-z0-9_-]{32,}$/.test(account.session.id)
    && isFiniteTimestamp(account.session.authenticatedAt);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Pre-contribution membership.json files lack contributorId/dataContribution.
 * Consent defaults to opted out — existing users must explicitly enable it;
 * a missing/invalid contributor id is regenerated lazily by getContributorId().
 */
function migrateStoredAccount(account: StoredAccount): StoredAccount {
  if (!isValidDataContribution(account.dataContribution)) {
    account.dataContribution = { ...DATA_CONTRIBUTION_DISABLED };
  }
  if (typeof account.contributorId !== 'string' || !account.contributorId) {
    delete account.contributorId;
  }
  return account;
}

function isValidDataContribution(value: unknown): value is DataContributionState {
  if (!isRecord(value)) return false;
  return typeof value.enabled === 'boolean'
    && (value.consentedAt === null || isFiniteTimestamp(value.consentedAt))
    && (value.version === null || typeof value.version === 'string')
    && (value.giftGranted === undefined || typeof value.giftGranted === 'boolean');
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isBase64OfLength(value: unknown, length: number): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  return Buffer.from(value, 'base64').length === length;
}
