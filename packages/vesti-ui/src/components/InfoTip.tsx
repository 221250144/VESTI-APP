import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Shared hover tooltip carrying a module title plus a 1–2 sentence functional
 * intro — the "label explanation system" for the app's major modules.
 *
 * Interaction contract mirrors the shell's DockTooltip (240ms hover/focus
 * delay, hides on leave/blur), but the bubble is position:fixed and
 * viewport-clamped, so it survives overflow:auto/hidden ancestors (an absolute
 * bubble would be clipped inside scrollable nav columns).
 */
export function InfoTip({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description: string;
  /** Trigger content. Optional in the type so `createElement` callers (tests)
   * can pass children as the third argument. */
  children?: ReactNode;
  /** Extra classes on the trigger wrapper (e.g. "min-w-0 flex-1" when the
   * child must keep filling a flex row). */
  className?: string;
}) {
  const [bubble, setBubble] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const show = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const el = triggerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // w-56 (224px) bubble centered on the trigger, clamped into the viewport.
      const half = 112;
      const left = Math.min(
        Math.max(rect.left + rect.width / 2, half + 8),
        window.innerWidth - half - 8,
      );
      // Flip below the trigger when there is not enough room above it.
      const above = rect.top > 110;
      setBubble({ left, top: above ? rect.top - 8 : rect.bottom + 8, above });
    }, 240);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    setBubble(null);
  };

  return (
    <span
      ref={triggerRef}
      className={`inline-flex ${className ?? ""}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {bubble ? (
        <span
          role="tooltip"
          className="pointer-events-none fixed z-50 block w-56 rounded-md border border-border-subtle bg-bg-primary px-2.5 py-2 text-left shadow-popover"
          style={{
            left: bubble.left,
            top: bubble.top,
            transform: bubble.above ? "translate(-50%, -100%)" : "translate(-50%, 0)",
          }}
        >
          <span className="block text-[12px] font-sans font-medium text-text-primary">{title}</span>
          <span className="mt-0.5 block text-[12px] font-sans leading-snug text-text-secondary">
            {description}
          </span>
        </span>
      ) : null}
    </span>
  );
}
