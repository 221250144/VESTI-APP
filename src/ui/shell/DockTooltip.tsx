import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Minimal tooltip that floats to the right of the dock rail. Pure CSS/DOM,
 * no portal: the trigger is position:relative, the bubble absolute.
 */
export function DockTooltip({
  label,
  description,
  children,
}: {
  label: string;
  /** Optional 1–2 sentence functional intro shown under the label. */
  description?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const show = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), 240);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
  };

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {open ? (
        description ? (
          <span
            role="tooltip"
            className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 w-56 -translate-y-1/2 rounded-md border border-border-subtle bg-bg-primary px-2.5 py-2 text-left shadow-popover"
          >
            <span className="block text-[12px] font-sans font-medium text-text-primary">
              {label}
            </span>
            <span className="mt-0.5 block text-[12px] font-sans leading-snug text-text-secondary">
              {description}
            </span>
          </span>
        ) : (
          <span
            role="tooltip"
            className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md border border-border-subtle bg-bg-primary px-2 py-1 text-[12px] font-sans text-text-primary shadow-popover"
          >
            {label}
          </span>
        )
      ) : null}
    </span>
  );
}
