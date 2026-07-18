import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

type UseResizableWidthOptions = {
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth?: number;
  getMaxWidth?: () => number;
  direction?: 1 | -1;
};

function readStoredWidth(storageKey: string): number | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(storageKey);
  if (!raw) {
    return null;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function useResizableWidth({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  getMaxWidth,
  direction = 1,
}: UseResizableWidthOptions) {
  const [width, setWidth] = useState(() => {
    const storedWidth = readStoredWidth(storageKey);
    return storedWidth ?? defaultWidth;
  });
  const [isDragging, setIsDragging] = useState(false);
  const widthRef = useRef(defaultWidth);
  const getMaxWidthRef = useRef(getMaxWidth);

  useEffect(() => {
    getMaxWidthRef.current = getMaxWidth;
  }, [getMaxWidth]);

  const clampWidth = useCallback(
    (nextWidth: number) => {
      const dynamicMax =
        getMaxWidthRef.current?.() ?? Number.POSITIVE_INFINITY;
      const resolvedMax = Math.max(
        minWidth,
        Math.min(maxWidth ?? Number.POSITIVE_INFINITY, dynamicMax),
      );

      return Math.round(Math.min(resolvedMax, Math.max(minWidth, nextWidth)));
    },
    [maxWidth, minWidth],
  );

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  useEffect(() => {
    const storedWidth = readStoredWidth(storageKey);
    const nextWidth = storedWidth ?? defaultWidth;
    setWidth(clampWidth(nextWidth));
  }, [defaultWidth, storageKey]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(storageKey, String(width));
  }, [storageKey, width]);

  useEffect(() => {
    setWidth((current) => clampWidth(current));
  }, [clampWidth]);

  useEffect(() => {
    const handleResize = () => {
      setWidth((current) => clampWidth(current));
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [clampWidth]);

  const setClampedWidth = useCallback(
    (nextWidth: number | ((current: number) => number)) => {
      setWidth((current) => {
        const resolved =
          typeof nextWidth === "function" ? nextWidth(current) : nextWidth;
        return clampWidth(resolved);
      });
    },
    [clampWidth],
  );

  const nudgeWidth = useCallback(
    (delta: number) => {
      setClampedWidth((current) => current + delta);
    },
    [setClampedWidth],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      const startX = event.clientX;
      const startWidth = widthRef.current;
      const target = event.currentTarget;
      target.setPointerCapture?.(event.pointerId);
      setIsDragging(true);

      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const delta = (moveEvent.clientX - startX) * direction;
        setWidth(clampWidth(startWidth + delta));
      };

      const stopDragging = () => {
        target.releasePointerCapture?.(event.pointerId);
        setIsDragging(false);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", stopDragging);
        window.removeEventListener("pointercancel", stopDragging);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", stopDragging);
      window.addEventListener("pointercancel", stopDragging);
    },
    [clampWidth, direction],
  );

  return useMemo(
    () => ({
      width,
      isDragging,
      setWidth: setClampedWidth,
      nudgeWidth,
      handlePointerDown,
    }),
    [handlePointerDown, isDragging, nudgeWidth, setClampedWidth, width],
  );
}
