// The demo hub: a Trialog anyone may try, for screenshots, simulators and checking the page.
// It runs without a database (messages live in memory and are gone after a restart or a deploy),
// and its tokens are public, listed in docs/demo.md and below. Never give it a database.

/** On the page: whether this build is the demo hub (next.config.ts writes TRIALOG_DEMO in at build time). */
export const DEMO_BUILD: boolean = process.env.TRIALOG_DEMO === '1';

/** On the server: true on the demo hub, TRIALOG_DEMO=1. */
export function isDemo(env: Record<string, string | undefined> = process.env): boolean {
  return env.TRIALOG_DEMO === '1';
}

/**
 * The demo hub's participants and their public tokens. The deployment sets the same values
 * (PARTICIPANTS and <NAME>_TOKEN, see docs/demo.md); the page uses them for its sign-in buttons.
 */
export const DEMO_PARTICIPANTS = [
  { name: 'david', label: 'Orchestrator', token: 'demo-orchestrator-public-token' },
  { name: 'claude', label: 'Claude', token: 'demo-claude-public-token' },
  { name: 'grok', label: 'Grok', token: 'demo-grok-public-token' },
] as const;
