import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";

/**
 * A draggable width for a left rail, persisted per caller.
 *
 * The app sidebar (SidebarShell) already owns this behaviour for itself, but it
 * is welded to the sidebar's collapse/pin states, so the tree rails on the wiki
 * and openspec pages take the same mechanics from here instead of each growing
 * their own copy.
 *
 * The width is handed back as a CSS variable rather than a plain `width`: the
 * rails are full-width above the `sm` breakpoint's column layout, so the pixel
 * width may only apply at `sm` and up (`sm:w-[var(--rail-w)]`). An inline
 * `width` would leak into the phone layout.
 */
export interface ResizableRail {
  width: number;
  isResizing: boolean;
  /** Spread on the rail element; carries the width as `--rail-w`. */
  railStyle: CSSProperties;
  /** Spread on the drag handle; it must sit inside a `relative` rail. */
  handleProps: {
    role: "separator";
    "aria-label": string;
    "aria-orientation": "vertical";
    "aria-valuemin": number;
    "aria-valuemax": number;
    "aria-valuenow": number;
    tabIndex: 0;
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
    onLostPointerCapture: () => void;
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  };
}

const KEYBOARD_STEP = 16;

function read(storageKey: string, fallback: number, min: number, max: number) {
  try {
    const raw = window.localStorage.getItem(storageKey);
    const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  } catch {
    // Private windows throw on access; a fixed rail still beats a broken page.
    return fallback;
  }
}

function write(storageKey: string, width: number) {
  try {
    window.localStorage.setItem(storageKey, String(width));
  } catch {
    // Losing the preference is fine; dragging must keep working.
  }
}

export function useResizableRail({
  storageKey,
  defaultWidth = 288,
  min = 200,
  max = 640,
  label = "拖动调整目录宽度",
}: {
  storageKey: string;
  defaultWidth?: number;
  min?: number;
  max?: number;
  label?: string;
}): ResizableRail {
  const [width, setWidth] = useState(() => read(storageKey, defaultWidth, min, max));
  const [isResizing, setIsResizing] = useState(false);
  const widthRef = useRef(width);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    const stored = read(storageKey, defaultWidth, min, max);
    widthRef.current = stored;
    setWidth(stored);
  }, [storageKey, defaultWidth, min, max]);

  const clamp = useCallback((n: number) => Math.min(max, Math.max(min, n)), [min, max]);

  const apply = useCallback((next: number) => {
    const clamped = clamp(next);
    widthRef.current = clamped;
    setWidth(clamped);
    return clamped;
  }, [clamp]);

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: widthRef.current };
    setIsResizing(true);
  }, []);

  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    apply(drag.current.startWidth + event.clientX - drag.current.startX);
  }, [apply]);

  const end = useCallback(() => {
    if (!drag.current) return;
    drag.current = null;
    setIsResizing(false);
    write(storageKey, widthRef.current);
  }, [storageKey]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === "ArrowLeft" ? -KEYBOARD_STEP : event.key === "ArrowRight" ? KEYBOARD_STEP : 0;
    if (delta === 0) return;
    event.preventDefault();
    write(storageKey, apply(widthRef.current + delta));
  }, [apply, storageKey]);

  return {
    width,
    isResizing,
    railStyle: { "--rail-w": `${width}px` } as CSSProperties,
    handleProps: {
      role: "separator",
      "aria-label": label,
      "aria-orientation": "vertical",
      "aria-valuemin": min,
      "aria-valuemax": max,
      "aria-valuenow": width,
      tabIndex: 0,
      onPointerDown,
      onPointerMove,
      onPointerUp: end,
      onPointerCancel: end,
      onLostPointerCapture: end,
      onKeyDown,
    },
  };
}
