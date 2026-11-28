// Who waits on whom, read from the flight text: the pure part of the flight strip and of the merged
// check, so that the server (GET /api/health) and the page read a wait the same way. No React here.
import { REPO, REPO_PREFIXES, pullRequestNumbers } from './links';
import type { Flight, Participant } from '../lib/shared';

/**
 * The PRs of this hub a text names. Another repository's PR is not ours (Grok's review of PR 108): an
 * address of another repo, or a repo name in front, «other-app PR 36», is left out.
 */
export function ownPrs(text: string, repo: string | null = REPO, prefixes: Readonly<Record<string, string>> = REPO_PREFIXES): number[] {
  const ours = repo ? repo.toLowerCase() : '';
  const cleaned = text
    .replace(/https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})\/pull\/\d+/gi, (m, r: string) => (r.toLowerCase() === ours ? m : ' '))
    .replace(/(?:^|\s)[A-Za-z0-9_.]*[-/][A-Za-z0-9_./-]*\s+(?:PR|pull request)\s?#?\d+/gi, ' ');
  return pullRequestNumbers(cleaned, repo, prefixes);
}

/** True when the text names at least one PR of this hub and every one of them is merged. */
export function allMerged(text: string, merged: ReadonlySet<number>, repo: string | null = REPO): boolean {
  const prs = ownPrs(text, repo);
  return prs.length > 0 && prs.every((n) => merged.has(n));
}

/**
 * A wait on the orchestrator that a merge settles: it asks for a Ship it or a merge, and every PR it
 * names is merged. «Agree on decision card #791 (PR 101)» still waits, merged or not (Grok's review).
 */
export function settledByMerge(text: string, merged: ReadonlySet<number>, repo: string | null = REPO): boolean {
  return /ship it|\bmerge/i.test(text) && allMerged(text, merged, repo);
}


/**
 * What waits on a human: agents whose flight is «waiting» on that person. An agent says so by
 * starting its text with the human's name or label and a colon: «David: merge PR 36». The wait ends
 * by itself when the agent moves on (a new flight), so nothing has to be cleared by hand.
 */
export interface WaitOnHuman { by: string; text: string; since: string }
/**
 * A flight's text split into its steps: «David: merge PR 37; Grok: review PR 96» → one step for
 * David, one for Grok. A step starts with «Name:» (optionally «waiting for/on Name:»). The colon
 * must be followed by a space, so an address (https://…) never starts a step. Text without a name
 * is one step with name null.
 */
export function flightSteps(text: string): { name: string | null; text: string }[] {
  const named = /^\s*(?:waiting\s+(?:for|on)\s+)?@?([A-Za-z][\w .'-]{0,39}):\s+(.+)$/is;
  return text.split(/;\s+(?=(?:waiting\s+(?:for|on)\s+)?@?[A-Za-z][\w .'-]{0,39}:\s)/i).map((part) => {
    const m = named.exec(part);
    return m ? { name: m[1].trim(), text: m[2].trim() } : { name: null, text: part.trim() };
  }).filter((step) => step.text);
}

export function waitingOn(flights: readonly Flight[], human: Pick<Participant, 'name' | 'label'>, merged: ReadonlySet<number> = new Set(), repo: string | null = REPO): WaitOnHuman[] {
  const names = [human.name, human.label].filter(Boolean).map((n) => String(n).toLowerCase());
  return flights.flatMap((f) => {
    if (f.state !== 'waiting' || f.participant === human.name) return [];
    // Only the steps addressed to this human wait on them; «Grok: review PR 96» in the same flight does not (#743).
    // A step about PRs that are all merged is done, whatever the note still says (#813).
    return flightSteps(f.text).filter((step) => step.name !== null && names.includes(step.name.toLowerCase()) && !settledByMerge(step.text, merged, repo))
      .map((step) => ({ by: f.participant, text: step.text, since: f.since }));
  });
}

