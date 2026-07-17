import type { StorageUsageSnapshot, StorageUsageStatus } from "./types";
import { logger } from "./logger";

export const SOFT_LIMIT_BYTES = 900 * 1024 * 1024;
export const HARD_LIMIT_BYTES = 1024 * 1024 * 1024;

function resolveStatus(
  bytes: number,
  unlimited: boolean,
  quota: number | null,
): StorageUsageStatus {
  // On desktop IndexedDB is bounded by the per-origin quota, not our static
  // 1 GiB ceiling — gating on HARD_LIMIT_BYTES would silently stop captures
  // far below the real limit.
  if (unlimited) {
    if (quota && quota > 0) {
      if (bytes >= quota * 0.95) return "blocked";
      if (bytes >= quota * 0.85) return "warning";
    }
    return "ok";
  }
  if (bytes >= HARD_LIMIT_BYTES) return "blocked";
  if (bytes >= SOFT_LIMIT_BYTES) return "warning";
  return "ok";
}

function hasUnlimitedStorageEnabled(): boolean {
  // Desktop (Electron) has no extension-style storage ceiling: IndexedDB is
  // bounded only by the origin quota reported by the browser, so gate on the
  // quota instead of the static 1 GiB limit, same as the extension did with
  // the unlimitedStorage permission granted.
  return true;
}

async function getOriginEstimate(): Promise<{ usage: number; quota: number | null }> {
  try {
    if (!navigator?.storage?.estimate) {
      return { usage: 0, quota: null };
    }
    const estimate = await navigator.storage.estimate();
    return {
      usage: estimate.usage ?? 0,
      quota: typeof estimate.quota === "number" ? estimate.quota : null,
    };
  } catch {
    return { usage: 0, quota: null };
  }
}

async function getLocalUsage(): Promise<number> {
  // chrome.storage.local does not exist on desktop; UI prefs live in the main
  // process (window.vestiUi), so there is no extra local bucket to account for.
  return 0;
}

export async function getStorageUsageSnapshot(): Promise<StorageUsageSnapshot> {
  const [origin, localUsed] = await Promise.all([getOriginEstimate(), getLocalUsage()]);
  const unlimited = hasUnlimitedStorageEnabled();
  return {
    originUsed: origin.usage,
    originQuota: origin.quota,
    localUsed,
    unlimitedStorageEnabled: unlimited,
    softLimit: SOFT_LIMIT_BYTES,
    hardLimit: HARD_LIMIT_BYTES,
    status: resolveStatus(origin.usage, unlimited, origin.quota),
  };
}

export async function enforceStorageWriteGuard(): Promise<StorageUsageStatus> {
  const snapshot = await getStorageUsageSnapshot();
  if (snapshot.status === "blocked") {
    throw new Error("STORAGE_HARD_LIMIT_REACHED");
  }
  if (snapshot.status === "warning") {
    logger.warn("db", "Storage is above soft limit", {
      used: snapshot.originUsed,
      softLimit: snapshot.softLimit,
    });
  }
  return snapshot.status;
}

