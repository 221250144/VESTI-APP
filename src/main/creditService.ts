import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CreditBalance, CreditCategory, CreditEntry, CreditTier } from '../shared/contracts';
import { addUtcCalendarMonths } from './membershipService';

export const CREDITS_FILE_NAME = 'credits.json';
/** Beta member monthly allowance, reset on the membership's anchor day. */
export const MEMBER_MONTHLY_CREDITS = 50_000;
/** Free-tier daily allowance, reset at local midnight. */
export const FREE_DAILY_CREDITS = 300;

/** Fixed metered costs: chat is usage-based, image/embedding are flat. */
export const IMAGE_CREDITS_PER_GENERATION = 20;
export const EMBEDDING_CREDITS_PER_CALL = 1;

const MAX_LEDGER_ENTRIES = 200;
const RECENT_ENTRIES = 20;

export type CreditErrorCode = 'CREDITS_EXHAUSTED' | 'NOT_INITIALIZED' | 'INVALID_REQUEST';

export interface CreditAnchors {
  /** membership.startedAt — member cycles anchor on this day-of-month (UTC). */
  memberSince?: number | null;
}

export interface CreditConsumeInput extends CreditAnchors {
  tier: CreditTier;
  category: CreditCategory;
  /** Actual prompt+completion tokens from the response usage, when reported. */
  tokens?: number;
  /** Request-body character count, used to estimate tokens when no usage came back. */
  estimatedChars?: number;
  label: string;
}

export interface CreditPeekResult {
  balance: CreditBalance;
  /** What the described call would cost right now. */
  cost: number;
}

export class CreditError extends Error {
  constructor(
    public readonly code: CreditErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CreditError';
  }
}

interface StoredCreditLedger {
  version: 1;
  /** Cycle-start timestamp the cycleUsed counter belongs to. */
  cycleAnchor: number;
  cycleUsed: number;
  lifetimeUsed: number;
  /** Newest first; capped at MAX_LEDGER_ENTRIES. */
  entries: CreditEntry[];
}

interface CycleWindow {
  start: number;
  end: number;
}

/**
 * Local-first credit ledger (Beta): meters demo-gateway usage against a fixed
 * per-tier allowance. The ledger lives next to membership.json in userData and
 * is deliberately simple — a user with filesystem access can edit it, exactly
 * like the local membership store; server-issued metering replaces it when
 * paid plans ship.
 */
export class CreditService {
  private readonly filePath: string;
  private readonly now: () => number;
  private ledger: StoredCreditLedger | null = null;
  private initialized = false;
  private mutation = Promise.resolve();

  constructor(userDataDirectory: string, options: { now?: () => number } = {}) {
    this.filePath = path.join(userDataDirectory, CREDITS_FILE_NAME);
    this.now = options.now ?? Date.now;
  }

  async initialize(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      this.ledger = parseStoredLedger(raw);
    } catch (error) {
      // Corrupt or unreadable ledgers reset to a fresh one rather than
      // blocking the app — credits are metering, not entitlements.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[vesti] credits ledger unreadable, starting fresh:', error);
      }
      this.ledger = emptyLedger();
    }
    this.initialized = true;
  }

  /** Current balance view for the tier; never mutates the stored ledger. */
  getBalance(tier: CreditTier, anchors: CreditAnchors = {}): CreditBalance {
    this.assertInitialized();
    const ledger = this.currentLedger(tier, anchors);
    return this.balanceView(tier, anchors, ledger);
  }

  /** Metering pre-check: cost + balance view, no deduction. */
  peek(input: CreditConsumeInput): CreditPeekResult {
    this.assertInitialized();
    const cost = creditCost(input);
    const ledger = this.currentLedger(input.tier, input);
    return { balance: this.balanceView(input.tier, input, ledger), cost };
  }

  /**
   * Deduct the described usage and return the new balance. Throws
   * CreditError('CREDITS_EXHAUSTED') when the cycle allowance cannot cover it.
   */
  async consume(input: CreditConsumeInput): Promise<CreditBalance> {
    return this.runMutation(async () => {
      this.assertInitialized();
      const cost = creditCost(input);
      const ledger = this.currentLedger(input.tier, input);
      const quota = quotaFor(input.tier);
      if (ledger.cycleUsed + cost > quota) {
        throw new CreditError('CREDITS_EXHAUSTED', 'The current credit cycle is exhausted.');
      }
      const next: StoredCreditLedger = {
        version: 1,
        cycleAnchor: ledger.cycleAnchor,
        cycleUsed: ledger.cycleUsed + cost,
        lifetimeUsed: ledger.lifetimeUsed + cost,
        entries: [
          {
            ts: this.now(),
            category: input.category,
            credits: cost,
            label: input.label.slice(0, 120),
          },
          ...ledger.entries,
        ].slice(0, MAX_LEDGER_ENTRIES),
      };
      this.ledger = next;
      try {
        await this.persist();
      } catch (error) {
        this.ledger = ledger;
        throw error;
      }
      return this.balanceView(input.tier, input, next);
    });
  }

  /** Stored ledger rolled forward into the current cycle (view-only). */
  private currentLedger(tier: CreditTier, anchors: CreditAnchors): StoredCreditLedger {
    const ledger = this.ledger ?? emptyLedger();
    const window = cycleWindow(tier, anchors, this.now());
    if (ledger.cycleAnchor === window.start) return ledger;
    return { ...ledger, cycleAnchor: window.start, cycleUsed: 0 };
  }

  private balanceView(tier: CreditTier, anchors: CreditAnchors, ledger: StoredCreditLedger): CreditBalance {
    const quota = quotaFor(tier);
    const window = cycleWindow(tier, anchors, this.now());
    return {
      tier,
      quota,
      used: ledger.cycleUsed,
      remaining: Math.max(0, quota - ledger.cycleUsed),
      resetsAt: window.end,
      lifetimeUsed: ledger.lifetimeUsed,
      recent: ledger.entries.slice(0, RECENT_ENTRIES),
    };
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new CreditError('NOT_INITIALIZED', 'CreditService has not been initialized.');
    }
  }

  private async persist(): Promise<void> {
    if (!this.ledger) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temporaryPath, JSON.stringify(this.ledger, null, 2), {
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

export function quotaFor(tier: CreditTier): number {
  return tier === 'member' ? MEMBER_MONTHLY_CREDITS : FREE_DAILY_CREDITS;
}

/**
 * chat: ceil(totalTokens / 1000), minimum 1; without a usage payload the
 * request-body characters / 4 stand in for tokens. image/embedding are flat.
 */
export function creditCost(input: {
  category: CreditCategory;
  tokens?: number;
  estimatedChars?: number;
}): number {
  switch (input.category) {
    case 'image':
      return IMAGE_CREDITS_PER_GENERATION;
    case 'embedding':
      return EMBEDDING_CREDITS_PER_CALL;
    case 'chat': {
      const tokens = typeof input.tokens === 'number' && Number.isFinite(input.tokens) && input.tokens > 0
        ? input.tokens
        : typeof input.estimatedChars === 'number' && input.estimatedChars > 0
          ? input.estimatedChars / 4
          : 0;
      return Math.max(1, Math.ceil(tokens / 1000));
    }
  }
}

/** Cycle [start, end) the given instant belongs to for the tier. */
function cycleWindow(tier: CreditTier, anchors: CreditAnchors, now: number): CycleWindow {
  if (tier === 'member') {
    const since = typeof anchors.memberSince === 'number' && Number.isFinite(anchors.memberSince) && anchors.memberSince > 0
      ? anchors.memberSince
      : now;
    const anchor = new Date(since);
    const current = new Date(now);
    let months = (current.getUTCFullYear() - anchor.getUTCFullYear()) * 12
      + (current.getUTCMonth() - anchor.getUTCMonth());
    if (addUtcCalendarMonths(since, months) > now) months -= 1;
    if (months < 0) months = 0;
    return {
      start: addUtcCalendarMonths(since, months),
      end: addUtcCalendarMonths(since, months + 1),
    };
  }
  // Free tier: local calendar day.
  const day = new Date(now);
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
  return { start, end };
}

function emptyLedger(): StoredCreditLedger {
  return { version: 1, cycleAnchor: 0, cycleUsed: 0, lifetimeUsed: 0, entries: [] };
}

function parseStoredLedger(raw: string): StoredCreditLedger {
  const value = JSON.parse(raw) as unknown;
  if (!isValidStoredLedger(value)) throw new Error('The local credits ledger has an invalid format.');
  return value;
}

function isValidStoredLedger(value: unknown): value is StoredCreditLedger {
  if (!isRecord(value) || value.version !== 1) return false;
  if (!isFiniteTimestamp(value.cycleAnchor)) return false;
  if (!isNonNegativeNumber(value.cycleUsed) || !isNonNegativeNumber(value.lifetimeUsed)) return false;
  if (!Array.isArray(value.entries)) return false;
  return value.entries.every((entry) => {
    if (!isRecord(entry)) return false;
    return isFiniteTimestamp(entry.ts)
      && (entry.category === 'chat' || entry.category === 'image' || entry.category === 'embedding')
      && isNonNegativeNumber(entry.credits)
      && typeof entry.label === 'string';
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
