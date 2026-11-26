// The form that asks for a participant's token, and how a pasted token is cleaned up.

const BUTTON = 'shrink-0 cursor-pointer rounded-md border border-line bg-[#2a2f3a] px-3 py-[5px] hover:bg-[#343a47]';

/**
 * What was pasted, as a token: trimmed, and without a «NAME_TOKEN=» in front, because a token is
 * often copied from a settings line. Quotes around the value go too.
 */
export function cleanToken(pasted: string): string {
  let t = pasted.trim();
  const setting = /^[A-Z][A-Z0-9_]*=(.*)$/.exec(t);
  if (setting) t = setting[1].trim();
  const quoted = /^(["'])(.*)\1$/.exec(t);
  if (quoted) t = quoted[2].trim();
  return t;
}

export const REFUSED_NOTICE = 'This hub did not accept that token. Check that it is the token for this hub, and only the token itself.';

/**
 * Asks for the token. `refused`: the last token was turned down by the hub, so say so instead of
 * silently showing the empty field again.
 */
export function TokenForm({ onSave, refused = false }: { onSave: (token: string) => void; refused?: boolean }) {
  return (
    <main className="mx-auto mt-[18vh] max-w-[420px] px-4">
      <h1 className="my-[0.67em] text-[2em] font-bold">Trialog</h1>
      <p className="my-4 text-muted">Paste your token once. It stays in this browser (localStorage) and is only sent to this site.</p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const field = e.currentTarget.elements.namedItem('token') as HTMLInputElement | null;
          const t = cleanToken(field?.value ?? '');
          if (t) onSave(t);
        }}
      >
        {/* min-w-0: on a phone the field gives way, so the button stays on screen. */}
        <input
          name="token" type="password" autoFocus autoComplete="off" placeholder="Token" aria-label="Token"
          aria-invalid={refused || undefined} aria-describedby={refused ? 'token-refused' : undefined}
          className={`min-w-0 flex-1 rounded-md border bg-panel px-2.5 py-[7px] ${refused ? 'border-bad' : 'border-line'}`}
        />
        <button type="submit" className={BUTTON}>Open hub</button>
      </form>
      {refused && <p id="token-refused" role="alert" className="mt-3 text-sm text-bad">{REFUSED_NOTICE}</p>}
    </main>
  );
}
