// Extension import: receives vesti_export.v1 bundles forwarded by the main
// process's extension bridge (Bridge Protocol v1, POST /v1/import) and runs
// the idempotent [platform+uuid] merge import into Dexie. The result goes
// back to the main process, which answers the extension's HTTP request.
//
// Registered at module scope in the renderer entry so the listener exists
// before `did-finish-load` fires; outside Electron (no window.vesti bridge)
// it is a no-op.

import { importExtensionBundle } from "../db/repository";
import { logger } from "../db/logger";
import type { ExtensionImportRequestPayload } from "../../shared/contracts";

let started = false;

async function handleImport(payload: ExtensionImportRequestPayload): Promise<void> {
  try {
    const result = await importExtensionBundle(payload.bundle);
    // Notify the dashboard's library-data context that fresh data landed.
    window.dispatchEvent(new CustomEvent("vesti:data-updated"));
    await window.vesti.reportExtensionImportResult({
      requestId: payload.requestId,
      ...result,
    });
  } catch (error) {
    logger.error("db", "Extension import failed", error as Error);
    await window.vesti.reportExtensionImportResult({
      requestId: payload.requestId,
      conversations: 0,
      messages: 0,
      maxCapturedAt: null,
      error: (error as Error).message,
    });
  }
}

export function startExtensionImportHandler(): void {
  if (started) return;
  if (typeof window === "undefined" || !window.vesti) return;
  started = true;
  window.vesti.onExtensionImportRequest((payload) => {
    void handleImport(payload);
  });
}
