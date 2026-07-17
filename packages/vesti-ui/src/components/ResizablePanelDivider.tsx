import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

type ResizablePanelDividerProps = {
  ariaLabel: string;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onNudge?: (delta: number) => void;
  isDragging?: boolean;
  className?: string;
};

const KEYBOARD_STEP = 24;

export function ResizablePanelDivider({
  ariaLabel,
  onPointerDown,
  onNudge,
  isDragging = false,
  className,
}: ResizablePanelDividerProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!onNudge) {
      return;
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onNudge(-KEYBOARD_STEP);
      return;
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      onNudge(KEYBOARD_STEP);
    }
  };

  return (
    <div
      aria-hidden="true"
      className={`relative z-10 w-0 shrink-0 self-stretch overflow-visible ${className ?? ""}`}
    >
      <button
        type="button"
        aria-label={ariaLabel}
        title={ariaLabel}
        onPointerDown={onPointerDown}
        onKeyDown={handleKeyDown}
        onDragStart={(event) => event.preventDefault()}
        className="group absolute inset-y-0 left-1/2 flex w-3 -translate-x-1/2 touch-none cursor-col-resize items-stretch justify-center bg-transparent focus:outline-none"
      >
        <span className="sr-only">{ariaLabel}</span>
        <span
          aria-hidden="true"
          className={`my-2 w-px rounded-full ${
            isDragging
              ? "bg-text-tertiary"
              : "bg-border-subtle group-focus-visible:bg-accent-primary"
          }`}
        />
      </button>
    </div>
  );
}
