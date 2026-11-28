// What the demo hub shows that a real hub doesn't: a banner that says what this is, and one
// button per participant to sign in with its public token.
import { DEMO_PARTICIPANTS } from '../lib/demo';

const BUTTON = 'cursor-pointer rounded-md border border-line bg-[#2a2f3a] px-3 py-[5px] text-sm hover:bg-[#343a47]';

export const DEMO_BANNER = 'Demo hub: anyone can sign in, and messages are gone after the next deploy. Nothing here is private.';

export function DemoBanner() {
  return <div role="note" className="border-b border-line bg-[#1f1b12] px-4 py-1.5 text-center text-[13px] text-decision">{DEMO_BANNER}</div>;
}

/** Sign in as any demo participant with one click: their tokens are public (docs/demo.md). */
export function DemoSignIn({ onPick }: { onPick: (token: string) => void }) {
  return (
    <section aria-label="Sign in to the demo" className="mx-auto mt-[12vh] max-w-[420px] px-4">
      <p className="mb-2 text-sm text-muted">{DEMO_BANNER}</p>
      <div className="flex flex-wrap gap-2">
        {DEMO_PARTICIPANTS.map((p) => (
          <button key={p.name} type="button" className={BUTTON} onClick={() => onPick(p.token)}>Sign in as {p.label}</button>
        ))}
      </div>
    </section>
  );
}
