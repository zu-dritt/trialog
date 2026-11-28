// The demo hub: a Trialog anyone may try, for screenshots, simulators and checking the page.
// It runs without a database (messages live in memory and are gone after a restart or a deploy),
// and its tokens are public, listed in docs/demo.md and below. Never give it a database.

/** On the page: whether this build is the demo hub (next.config.ts writes TRIALOG_DEMO in at build time). */
export const DEMO_BUILD: boolean = process.env.TRIALOG_DEMO === '1';

/**
 * Where the demo hub is, for a link in the header of another hub (TRIALOG_DEMO_URL, written in at
 * build time). Only an https address counts; anything else, and the demo hub itself, gets no link.
 */
export function demoLink(value: string | undefined = process.env.TRIALOG_DEMO_URL, demo: boolean = DEMO_BUILD): string | null {
  if (demo || !value) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

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
