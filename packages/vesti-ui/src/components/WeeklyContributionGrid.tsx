import type { WeeklyContributionDay } from "../types";

interface WeeklyContributionGridProps {
  days?: WeeklyContributionDay[];
  emptyLabel: string;
}

const CELL_SIZE = 12;
const CELL_GAP = 4;
const COLUMN_COUNT = 7;
const GRID_STEP = CELL_SIZE + CELL_GAP;

/** APP design-token aware intensity ramp. Falls back to a calm green scale
 *  when CSS variables are absent (extension parity with desktop palette). */
const COLORS = [
  "var(--color-border-subtle, #e5e7eb)",
  "var(--color-accent-primary-200, #d1fae5)",
  "var(--color-accent-primary-300, #6ee7b7)",
  "var(--color-accent-primary-500, #10b981)",
  "var(--color-accent-primary-700, #047857)",
];

export function WeeklyContributionGrid({
  days = [],
  emptyLabel,
}: WeeklyContributionGridProps) {
  if (days.length === 0) {
    return <p className="text-vesti-xs text-text-tertiary">{emptyLabel}</p>;
  }

  const rowCount = Math.max(1, Math.ceil(days.length / COLUMN_COUNT));
  const width = COLUMN_COUNT * GRID_STEP - CELL_GAP;
  const height = rowCount * GRID_STEP - CELL_GAP;

  return (
    <svg
      role="img"
      aria-label={emptyLabel}
      viewBox={`0 0 ${width} ${height}`}
      className="block h-auto w-full max-w-[240px]"
    >
      {days.map((day, index) => {
        const intensity = Math.max(0, Math.min(4, Math.round(day.intensity ?? 0)));
        const label = `${day.date}: ${day.count ?? 0}`;
        return (
          <rect
            key={`${day.date}-${index}`}
            x={(index % COLUMN_COUNT) * GRID_STEP}
            y={Math.floor(index / COLUMN_COUNT) * GRID_STEP}
            width={CELL_SIZE}
            height={CELL_SIZE}
            rx={3}
            fill={COLORS[intensity]}
            aria-label={label}
          >
            <title>{label}</title>
          </rect>
        );
      })}
    </svg>
  );
}
