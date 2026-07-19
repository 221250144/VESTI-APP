import { Users } from "lucide-react";
import type { DashboardLabels, StorageApi, UiThemeMode } from "../types";

// AI 圆桌 (Roundtable): honest degradation. The multi-turn orchestration
// (2-3 persona seats + a moderator synthesis) is still being designed, and
// the previous fake run returned an empty result that read like a bug — so
// the panel now shows a plain "coming soon" card describing the intent
// instead of pretending to work. The props stay compatible with the host so
// the real implementation can slot back in without call-site changes.

interface RoundtablePanelProps {
  storage: StorageApi;
  themeMode?: UiThemeMode;
  labels: DashboardLabels["roundtable"];
  /** Reserved for the future "Send to…" export of the synthesis. */
  sendToLabels?: DashboardLabels["library"];
}

export function RoundtablePanel({ labels }: RoundtablePanelProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center p-10 text-center">
      <div
        className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-accent-primary-light text-accent-primary"
        aria-hidden="true"
      >
        <Users className="h-5 w-5" strokeWidth={1.75} />
      </div>
      <h3 className="text-[15px] font-medium text-text-primary">{labels.comingSoonTitle}</h3>
      <p className="mt-2 max-w-md text-[13px] leading-relaxed text-text-tertiary">
        {labels.comingSoonBody}
      </p>
    </div>
  );
}
