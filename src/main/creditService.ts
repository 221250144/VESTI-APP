import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  CreditBalance,
  CreditCategory,
  CreditEntry,
  CreditTier,
  CrowdfundRedeemResult,
} from '../shared/contracts';
import { demoOpenAiBase } from './chatStream';
import { addUtcCalendarMonths } from './membershipService';
import { DEMO_BASE_URL, DEMO_SERVICE_TOKEN } from './settingsService';

export const CREDITS_FILE_NAME = 'credits.json';
/** Beta member monthly allowance, reset on the membership's anchor day. */
export const MEMBER_MONTHLY_CREDITS = 50_000;
/** Free-tier daily allowance, reset at local midnight. */
export const FREE_DAILY_CREDITS = 300;
/** One-time gift granted the first time an account enables data contribution. */
export const DATA_CONTRIBUTION_GIFT_CREDITS = 2_000;

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

export interface CreditGrantInput extends CreditAnchors {
  tier: CreditTier;
  /** Positive credits added to the persistent bonus pool. */
  credits: number;
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
  /**
   * 奖励池(如众筹码兑换打入的积分):跨周期不失效,消耗时先扣周期额度、
   * 不足再从奖励池补。旧账本没有此字段,解析时按 0 归一。
   */
  bonusCredits: number;
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
      // 周期额度先扣;不够用奖励池(众筹码兑换等)兜底,奖励池跨周期保留。
      const cycleRemaining = Math.max(0, quota - ledger.cycleUsed);
      if (cycleRemaining + ledger.bonusCredits < cost) {
        throw new CreditError('CREDITS_EXHAUSTED', 'The current credit cycle is exhausted.');
      }
      const fromCycle = Math.min(cycleRemaining, cost);
      const next: StoredCreditLedger = {
        version: 1,
        cycleAnchor: ledger.cycleAnchor,
        cycleUsed: ledger.cycleUsed + fromCycle,
        bonusCredits: ledger.bonusCredits - (cost - fromCycle),
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

  /**
   * Add credits to the persistent bonus pool (crowdfund code redemptions).
   * Unlike the cycle allowance the pool never resets; consumption draws the
   * cycle allowance first and dips into the pool only when that is exhausted.
   */
  async grantBonus(input: CreditGrantInput): Promise<CreditBalance> {
    return this.runMutation(async () => {
      this.assertInitialized();
      if (!Number.isInteger(input.credits) || input.credits <= 0) {
        throw new CreditError('INVALID_REQUEST', 'Bonus credits must be a positive integer.');
      }
      const ledger = this.currentLedger(input.tier, input);
      const entry: CreditEntry = {
        ts: this.now(),
        category: 'grant',
        credits: input.credits,
        label: input.label.slice(0, 120),
      };
      const next: StoredCreditLedger = {
        ...ledger,
        bonusCredits: ledger.bonusCredits + input.credits,
        entries: [entry, ...ledger.entries].slice(0, MAX_LEDGER_ENTRIES),
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
      remaining: Math.max(0, quota - ledger.cycleUsed + ledger.bonusCredits),
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
    case 'grant':
      return 0; // 奖励入账不是计量消耗
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
  return { version: 1, cycleAnchor: 0, cycleUsed: 0, bonusCredits: 0, lifetimeUsed: 0, entries: [] };
}

function parseStoredLedger(raw: string): StoredCreditLedger {
  const value = JSON.parse(raw) as unknown;
  if (!isValidStoredLedger(value)) throw new Error('The local credits ledger has an invalid format.');
  // Ledgers written before the bonus pool existed carry no bonusCredits — 0.
  return { ...value, bonusCredits: value.bonusCredits ?? 0 };
}

function isValidStoredLedger(value: unknown): value is StoredCreditLedger {
  if (!isRecord(value) || value.version !== 1) return false;
  if (!isFiniteTimestamp(value.cycleAnchor)) return false;
  if (!isNonNegativeNumber(value.cycleUsed) || !isNonNegativeNumber(value.lifetimeUsed)) return false;
  if (value.bonusCredits !== undefined && !isNonNegativeNumber(value.bonusCredits)) return false;
  if (!Array.isArray(value.entries)) return false;
  return value.entries.every((entry) => {
    if (!isRecord(entry)) return false;
    return isFiniteTimestamp(entry.ts)
      && (entry.category === 'chat' || entry.category === 'image' || entry.category === 'embedding' || entry.category === 'grant')
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

// ---- 众筹「众筹码」兑换 ----

export const CROWDFUND_REDEEM_TIMEOUT_MS = 15_000;

/**
 * 码格式:VESTI-XXXX-XXXX-XXXX,Crockford 风格大写无歧义字符(不含 I/L/O/U)。
 * 与服务端 deploy/vesti-gate/crowdfund.mjs 的规则保持一致。
 */
const CROWDFUND_CODE_PATTERN = /^VESTI-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

/** 归一化用户输入(大小写/空白/Unicode 破折号/省略连字符),与服务端同规则。 */
export function normalizeCrowdfundCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let text = raw.normalize('NFKC').trim().toUpperCase();
  if (!text) return null;
  text = text.replace(/[‐-―−]/g, '-').replace(/\s+/g, '');
  if (!text.startsWith('VESTI')) return text;
  const body = text.slice('VESTI'.length).replace(/^-/, '').replace(/-/g, '');
  if (body.length !== 12) return text;
  return `VESTI-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

export interface CrowdfundRedeemOptions {
  /** 默认官方网关 https://vesti.world/gate/v1/crowdfund/redeem。 */
  endpoint?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function crowdfundRedeemEndpoint(): string {
  return `${demoOpenAiBase(DEMO_BASE_URL)}/crowdfund/redeem`;
}

/**
 * 兑换一次性众筹码:POST 网关核销 → 成功后把档位积分打入本地奖励池
 * (grantBonus)。永不 reject——所有失败归为 invalid_code / already_redeemed /
 * network_error 三种,供设置页分类提示。
 */
export async function redeemCrowdfundCode(
  credits: CreditService,
  rawCode: unknown,
  context: { tier: CreditTier; memberSince: number | null },
  options: CrowdfundRedeemOptions = {},
): Promise<CrowdfundRedeemResult> {
  const code = normalizeCrowdfundCode(rawCode);
  if (!code || !CROWDFUND_CODE_PATTERN.test(code)) {
    return { ok: false, error: 'invalid_code' };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? CROWDFUND_REDEEM_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(options.endpoint ?? crowdfundRedeemEndpoint(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vesti-service-token': options.token ?? DEMO_SERVICE_TOKEN,
      },
      body: JSON.stringify({ code }),
      signal: controller.signal,
    });
  } catch {
    return { ok: false, error: 'network_error' };
  } finally {
    clearTimeout(timer);
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch { /* 非 JSON 响应按状态码归类 */ }
  const message = isRecord(payload) && isRecord(payload.error) ? payload.error.message : undefined;
  if (!response.ok) {
    if (message === 'already_redeemed') return { ok: false, error: 'already_redeemed' };
    if (message === 'invalid_code') return { ok: false, error: 'invalid_code' };
    // 401/429/5xx 等统一按网络类问题提示,不泄露网关细节
    return { ok: false, error: 'network_error' };
  }
  const tier = isRecord(payload) && typeof payload.tier === 'string' ? payload.tier : '';
  const granted = isRecord(payload) && typeof payload.credits === 'number' ? payload.credits : NaN;
  if (!tier || !Number.isInteger(granted) || granted <= 0) {
    return { ok: false, error: 'network_error' };
  }
  const balance = await credits.grantBonus({
    tier: context.tier,
    memberSince: context.memberSince,
    credits: granted,
    label: `众筹兑换 · ${tier}`,
  });
  return { ok: true, tier, credits: granted, balance };
}
