'use client';

// The «⋯» menu at the end of the header: what is used rarely (header refresh, playground #539).
// Who you are on top, then the demo hub, the wake-ups, Export .md, and Switch token last. On a phone
// the Roadmap link joins them. Escape, a pick or a press anywhere else closes the menu.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

/** What every row may have: a line above it, and classes (e.g. «sm:hidden» for phone-only rows). */
interface RowLook { label: string; divider?: boolean; className?: string }
/**
 * A menu item does something (`onPick`), opens a page in a new tab (`href`), or only says something
 * (`info`, e.g. «Wake-ups: none set»): plain text, not a button.
 */
export type MoreItem = RowLook & (
  | { onPick: () => void; href?: undefined; info?: undefined }
  | { href: string; onPick?: undefined; info?: undefined; /** A named tab to reuse; a new one by default. */ target?: string }
  | { info: true; onPick?: undefined; href?: undefined }
);

const ITEM = 'cursor-pointer whitespace-nowrap border-none bg-transparent px-3 py-1.5 text-left text-[13px] text-fg hover:bg-[#2a2f3a]';

/** The «⋯» button and, when open, its list. It shows on every width; `className` adds classes to its wrapper. */
export function MoreMenu({ items, heading, className = '', initiallyOpen = false }: { items: readonly MoreItem[]; /** Shown on top, e.g. «Signed in as …». */ heading?: ReactNode; className?: string; initiallyOpen?: boolean }) {
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
        <div id={menuId} role="menu" className="absolute right-0 top-full z-40 mt-1.5 flex min-w-[13rem] flex-col rounded-md border border-line bg-panel py-1 shadow-lg shadow-black/50">
          {heading && <div role="none" className="border-b border-line px-3 pb-2 pt-1 text-[13px] text-muted">{heading}</div>}
          {items.map((item) => {
            const look = `${item.divider ? 'mt-1 border-t border-line pt-2' : ''} ${item.className ?? ''}`.trim();
            if (item.info) return <div key={item.label} role="none" className={`max-w-[20rem] px-3 py-1.5 text-[13px] text-muted ${look}`.trimEnd()}>{item.label}</div>;
            return item.href !== undefined ? (
              <a
                key={item.label} role="menuitem" href={item.href} target={item.target ?? '_blank'} rel="noopener noreferrer"
                className={`${ITEM} no-underline ${look}`.trimEnd()}
                onClick={() => setOpen(false)}
              >{item.label} ↗</a>
            ) : (
              <button
                key={item.label} type="button" role="menuitem"
                className={`${ITEM} ${look}`.trimEnd()}
                onClick={() => { setOpen(false); item.onPick(); }}
              >{item.label}</button>
            );
          })}
        </div>
      )}
    </div>
  );
}
