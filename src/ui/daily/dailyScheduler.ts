// P4c daily log scheduler: decides which local days still need a daily log
// and generates them. The decision core (computePendingDailyDates,
// normalizeDailyTime) is pure and unit-tested; the timer loop at the bottom
// is the only side effect and mirrors startAutoClassifyTrigger's pattern.

import { listDailyLogs } from "../db/repository";
import { addDaysToDateString, pad2, todayDateString } from "./dailyActivity";
import { generateDailyLog } from "./dailyService";

export const DEFAULT_DAILY_TIME = "21:30";
export const DAILY_TIME_PREF_KEY = "daily.time";

const TICK_MS = 60_000;

/** Normalize a stored "HH:MM" preference; anything malformed → default. */
export function normalizeDailyTime(value: unknown): string {
  if (typeof value === "string") {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (match) {
      const hours = Number(match[1]);
      const minutes = Number(match[2]);
      if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
        return `${pad2(hours)}:${pad2(minutes)}`;
      }
    }
  }
  return DEFAULT_DAILY_TIME;
}

export interface PendingDailyInput {
  now: number;
  /** Normalized "HH:MM". */
  scheduledTime: string;
  /** Dates ("YYYY-MM-DD") that already have a log. */
  existingDates: Iterable<string>;
}

/**
 * Dates that should have a daily log but don't, oldest first:
 * - yesterday, whenever it has no log (the app was off at the scheduled time);
 * - today, once the scheduled time has passed and no log exists yet.
 * The date's unique index plus upsert semantics make regeneration idempotent.
 */
export function computePendingDailyDates(input: PendingDailyInput): string[] {
  const existing = new Set(input.existingDates);
  const today = todayDateString(input.now);
  const pending: string[] = [];

  const yesterday = addDaysToDateString(today, -1);
  if (yesterday && !existing.has(yesterday)) pending.push(yesterday);

  const [hours, minutes] = input.scheduledTime.split(":").map(Number);
  const scheduledAt = new Date(input.now);
  scheduledAt.setHours(hours || 0, minutes || 0, 0, 0);
  if (input.now >= scheduledAt.getTime() && !existing.has(today)) pending.push(today);

  return pending;
}

// ---- Timer loop (side effects) ---------------------------------------------

let started = false;
let running = false;

/** One catch-up pass: generate every pending day, oldest first. Re-entrant
 * safe — overlapping ticks (a slow LLM call) collapse onto the same pass. */
async function runDailyCatchUp(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const stored = await window.vestiUi?.getUiPreference(DAILY_TIME_PREF_KEY).catch(() => null);
    const scheduledTime = normalizeDailyTime(stored);
    const logs = await listDailyLogs().catch(() => []);
    const pending = computePendingDailyDates({
      now: Date.now(),
      scheduledTime,
      existingDates: logs.map((log) => log.date),
    });
    for (const date of pending) {
      // Days without activity resolve null and simply stay unlogged; a
      // successful generation fires vesti:daily-updated from the service.
      await generateDailyLog(date, "auto").catch(() => null);
    }
  } finally {
    running = false;
  }
}

/**
 * Start the daily scheduler: an immediate catch-up pass at app launch
 * (covers yesterday-missed and today-past-time), then a 1-minute tick that
 * catches the moment the scheduled time passes while the app is running.
 */
export function startDailyScheduler(): void {
  if (started) return;
  if (typeof window === "undefined" || !window.vesti) return;
  started = true;
  void runDailyCatchUp();
  window.setInterval(() => void runDailyCatchUp(), TICK_MS);
}
