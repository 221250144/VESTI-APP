"use client";

interface GraphLegendProps {
  /** Swatches currently driving node colors (emotion families on the
   * conversation sphere). */
  groups?: { key: string; label: string; color: string }[];
  /** Free-form footnotes after the swatches (e.g. non-color visual channels). */
  notes?: string[];
}

export function GraphLegend({ groups, notes }: GraphLegendProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] font-sans text-text-tertiary">
      {groups?.map((group) => (
        <div key={group.key} className="flex items-center gap-1.5">
          <span
            className="h-[7px] w-[7px] rounded-full"
            style={{ backgroundColor: group.color }}
          />
          <span>{group.label}</span>
        </div>
      ))}
      {notes?.map((note) => (
        <span key={note} className="text-text-tertiary/70">
          {note}
        </span>
      ))}
    </div>
  );
}
