import { useEffect, useRef } from 'react';

/**
 * Standard dismiss behavior for popovers/dropdowns/inline forms: click
 * anywhere outside the referenced element, or press Escape, to close.
 * Explicit close/cancel controls stay in place — this is additive.
 */
export function useDismiss<T extends HTMLElement>(onDismiss: () => void, active = true) {
  const ref = useRef<T | null>(null);
  const cb = useRef(onDismiss);
  cb.current = onDismiss;

  useEffect(() => {
    if (!active) return;
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) cb.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cb.current();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [active]);

  return ref;
}
