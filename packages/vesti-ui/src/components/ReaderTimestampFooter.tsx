"use client";

import { ChevronDown } from "lucide-react";
import type { ReaderTimestampFooterModel } from "../lib/reader-timestamps";

type ReaderTimestampFooterProps = {
  model: ReaderTimestampFooterModel;
  className?: string;
};

export function ReaderTimestampFooter({
  model,
  className,
}: ReaderTimestampFooterProps) {
  return (
    <details className={className ? `group ${className}` : "group"}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-md text-left text-[13px] font-sans text-text-secondary transition-colors duration-150 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus marker:content-none [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1 truncate">
          Started {model.summaryStarted}
          <span className="px-1 text-text-tertiary" aria-hidden="true">
            |
          </span>
          last updated {model.summaryUpdated}
        </span>
        <ChevronDown
          className="h-4 w-4 shrink-0 transition-transform duration-200 group-open:rotate-180"
          strokeWidth={1.75}
        />
      </summary>

      <div className="mt-3 grid gap-2 text-[12px] font-sans text-text-secondary sm:grid-cols-2">
        {model.details.map((detail) => (
          <div
            key={detail.key}
            className="rounded-md border border-border-subtle bg-bg-secondary/50 px-3 py-2"
          >
            <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-text-tertiary">
              {detail.label}
            </div>
            <div className="mt-1 leading-relaxed text-text-secondary">{detail.value}</div>
          </div>
        ))}
      </div>
    </details>
  );
}
