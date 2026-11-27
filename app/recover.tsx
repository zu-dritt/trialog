'use client';

// When the page breaks (playground #869: Next's «This page couldn't load»). The usual cause is a
// new release while the tab is open: the page asks for a piece of the old build and the server only
// has the new one. Reloading fixes that, so the page reloads once by itself. If it breaks again
// within a minute, it is a real error: then it stays, and shows what went wrong in small print, so a
// screenshot tells us the cause. Nothing is sent anywhere.
import { useEffect, useState } from 'react';

export const RELOADED_KEY = 'trialog-auto-reload-at';
export const RELOAD_WINDOW_MS = 60_000;

interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }

/** Reload once: true unless the page already reloaded itself within RELOAD_WINDOW_MS. Notes the time. */
export function shouldReload(storage: StorageLike | null, now: number): boolean {
  if (!storage) return false;
  const last = Number(storage.getItem(RELOADED_KEY) || 0);
  if (last && now - last < RELOAD_WINDOW_MS) return false;
  storage.setItem(RELOADED_KEY, String(now));
  return true;
}

/** The error in one short line for the small print: name, message and Next's digest. */
export function errorLine(error: { name?: string; message?: string; digest?: string }): string {
  const what = [error.name, error.message].filter(Boolean).join(': ') || 'Unknown error';
  return `${what.slice(0, 300)}${error.digest ? ` (digest ${error.digest})` : ''}`;
}

const session = (): StorageLike | null => {
  try { return window.sessionStorage; } catch { return null; }
};

export function Recover({ error, reset }: { error: Error & { digest?: string }; reset?: () => void }) {
  const [reloading, setReloading] = useState(true);
  useEffect(() => {
    if (shouldReload(session(), Date.now())) window.location.reload();
    else setReloading(false);
  }, []);
  return (
    <div role="alert" style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 24, background: '#0f1115', color: '#e6e8ee', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ maxWidth: 520 }}>
        <h1 style={{ fontSize: 22, margin: '0 0 8px' }}>{reloading ? 'Loading the newest version…' : 'This page broke'}</h1>
        {!reloading && (
          <>
            <p style={{ margin: '0 0 14px', color: '#8b91a0' }}>Reloading didn&apos;t help, so this is a real error. A screenshot of this page helps us find it.</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" onClick={() => window.location.reload()} style={{ cursor: 'pointer', borderRadius: 6, border: '1px solid #262a33', background: '#e6e8ee', color: '#0f1115', padding: '6px 14px', fontWeight: 600 }}>Reload</button>
              {reset && <button type="button" onClick={reset} style={{ cursor: 'pointer', borderRadius: 6, border: '1px solid #262a33', background: 'transparent', color: '#e6e8ee', padding: '6px 14px' }}>Try again</button>}
            </div>
            <p data-error-line="" style={{ marginTop: 16, fontSize: 12, color: '#8b91a0', fontFamily: 'ui-monospace, monospace', wordBreak: 'break-word' }}>{errorLine(error)}</p>
          </>
        )}
      </div>
    </div>
  );
}
