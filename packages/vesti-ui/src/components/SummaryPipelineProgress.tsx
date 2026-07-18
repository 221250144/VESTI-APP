import { Check } from "lucide-react";

export interface PipelineStageState {
  stage: string;
  label: string;
  status: "pending" | "in_progress" | "completed" | "degraded_fallback";
}

interface SummaryPipelineProgressProps {
  stages: PipelineStageState[];
}

export function SummaryPipelineProgress({ stages }: SummaryPipelineProgressProps) {
  return (
    <div className="space-y-2 py-2">
      {stages.map((item) => (
        <div key={item.stage} className="flex items-center gap-2.5">
          <div className="w-4 h-4 flex items-center justify-center shrink-0">
            {item.status === "completed" && (
              <div className="w-4 h-4 rounded-full bg-success/15 flex items-center justify-center">
                <Check className="w-2.5 h-2.5 text-success" strokeWidth={2} />
              </div>
            )}
            {item.status === "in_progress" && (
              <div className="w-3.5 h-3.5 rounded-full border-2 border-accent-primary border-t-transparent animate-spin" />
            )}
            {item.status === "degraded_fallback" && (
              <div className="w-4 h-4 rounded-full bg-warning/15 flex items-center justify-center">
                <span className="text-[9px] text-warning font-bold">!</span>
              </div>
            )}
            {item.status === "pending" && (
              <div className="w-3 h-3 rounded-full border border-border-default" />
            )}
          </div>
          <span
            className={`text-[13px] font-sans ${
              item.status === "completed"
                ? "text-text-secondary"
                : item.status === "in_progress"
                  ? "text-text-primary font-medium"
                  : item.status === "degraded_fallback"
                    ? "text-warning"
                    : "text-text-tertiary"
            }`}
          >
            {item.label}
          </span>
        </div>
      ))}
    </div>
  );
}
