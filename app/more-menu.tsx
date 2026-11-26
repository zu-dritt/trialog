'use client';

// On a phone the header has no room for every button. Export .md and Switch token, which are not
// needed often, move into a small «⋯» menu there. They do exactly what the header buttons do on a
// wider screen. Escape, a pick or a press anywhere else closes the menu.
import { useEffect, useId, useRef, useState } from 'react';

export interface MoreItem {
  label: string;
  onPick: () => void;
}

/** The «⋯» button and, when open, its list. `className` decides where it shows (e.g. only below sm). */
export function MoreMenu({ items, className = '', initiallyOpen = false }: { items: readonly MoreItem[]; className?: string; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const inside = rootRef.current?.contains(document.activeElement);
      setOpen(false);
      if (inside) buttonRef.current?.focus();
    };
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node | null)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={`relative flex-none ${className}`.trimEnd()}>
      <button
        ref={buttonRef} type="button"
        className="cursor-pointer rounded-md border border-line bg-transparent px-2.5 py-[5px] leading-none text-muted hover:text-fg"
        aria-label="More" title="More" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
      >⋯</button>
      {open && (
        <div id={menuId} role="menu" className="absolute right-0 top-full z-40 mt-1.5 flex min-w-[10rem] flex-col rounded-md border border-line bg-panel py-1 shadow-lg shadow-black/50">
          {items.map((item) => (
            <button
              key={item.label} type="button" role="menuitem"
              className="cursor-pointer whitespace-nowrap border-none bg-transparent px-3 py-1.5 text-left text-[13px] text-fg hover:bg-[#2a2f3a]"
              onClick={() => { setOpen(false); item.onPick(); }}
            >{item.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}
