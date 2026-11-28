'use client';

// Health chips, to the right of the Guard ring under the message box: one small chip per agent with
// a heartbeat dot, the agent's emoji and one word for what it is doing. The dot is green while the hub
// heard from the agent in the last 10 minutes (a message, its status or its flight), amber from 10, grey
// from 20: a watcher that hangs goes grey on its own, with no self-report. The chip turns red while the
// agent waits on a human. Hover, focus or a tap opens the detail: «Claude · <flight text> · last merge:
// PR 133, 09:48». The numbers come from GET /api/health (lib/health.ts); nothing is stored for them.
import { useEffect, useId, useRef, useState } from 'react';
import { FlightText, flightAge } from './flight';
import { REPO, pullRequestUrl } from './links';
import { heartbeatOf, type AgentHealth, type Heartbeat, type HealthReport } from '../lib/health';
import { colorOf, labelOf, type Participant } from '../lib/shared';

/** How often the chips ask GET /api/health (the flight strip asks every 15 s too). */
export const HEALTH_POLL_MS = 15_000;

type ApiFn = (path: string, options?: RequestInit) => Promise<Response>;

export const HEARTBEAT_COLORS: Record<Heartbeat, string> = { green: '#3fb950', amber: '#d29922', grey: '#6e7681' };
const BLOCKED_COLOR = '#f85149';

const timeFmt = new Intl.DateTimeFormat('de-CH', { hour: '2-digit', minute: '2-digit' });
const timeOf = (iso: string): string => timeFmt.format(new Date(iso));

/** An agent as shown now: the hub's age of its last word, moved on by the time since the page asked. */
export function ageNow(agent: Pick<AgentHealth, 'heard_ago_ms'>, fetchedAt: number, now: number): number | null {
  return agent.heard_ago_ms === null ? null : agent.heard_ago_ms + Math.max(0, now - fetchedAt);
}

/** «heard just now», «heard 12 min ago», «not heard today». */
export function heardText(ageMs: number | null): string {
  if (ageMs === null) return 'not heard today';
  const age = flightAge(new Date(0).toISOString(), ageMs);
  return age === 'now' ? 'heard just now' : `heard ${age} ago`;
}

/** The detail in one line, as the tooltip's first words: «Claude · building «PR 7» · last merge: PR 133, 09:48». */
export function detailLine(agent: AgentHealth, label: string, format: (iso: string) => string = timeOf): string {
  const doing = agent.state === 'idle' || !agent.text ? 'resting' : `${agent.word} «${agent.text}»`;
  const merge = agent.last_merge ? `last merge: PR ${agent.last_merge.pr}, ${format(agent.last_merge.merged_at)}` : 'no merge of its own yet';
  return [label, doing, merge].join(' · ');
}

/** The chip's look: heartbeat colour, emoji and word, and whether it is red. */
export function chipLook(agent: AgentHealth, ageMs: number | null): { heartbeat: Heartbeat; emoji: string; word: string; blocked: boolean } {
  const blocked = agent.blocked !== null;
  return { heartbeat: heartbeatOf(ageMs), emoji: blocked ? '⛔' : agent.emoji, word: blocked ? 'blocked' : agent.word, blocked };
}

export function HealthChip({ agent, ageMs, participants }: { agent: AgentHealth; ageMs: number | null; participants: readonly Participant[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const tipId = useId();
  const label = labelOf(agent.participant, participants);
  const look = chipLook(agent, ageMs);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e: Event) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const color = look.blocked ? BLOCKED_COLOR : colorOf(agent.participant, participants);
  return (
    <span ref={ref} data-health={agent.participant} data-heartbeat={look.heartbeat} data-blocked={look.blocked ? '' : undefined} className="group relative inline-flex flex-none max-sm:static">
      <button
        type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-describedby={tipId}
        aria-label={`${label}: ${look.word}, ${heardText(ageMs)}`}
        className={`inline-flex h-[26px] cursor-pointer items-center gap-[5px] whitespace-nowrap rounded-full border bg-[#1a1d25] px-2 text-xs leading-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${look.blocked ? 'border-bad bg-[#2a1618]' : 'border-line'}`}
        style={{ color, ...(look.blocked ? {} : { borderColor: `color-mix(in srgb, ${color} 45%, #262a33)` }) }}
      >
        <span aria-hidden="true" className={`block h-[7px] w-[7px] flex-none rounded-full ${look.heartbeat === 'green' ? 'health-beat' : ''}`} style={{ background: HEARTBEAT_COLORS[look.heartbeat] }} />
        <span aria-hidden="true">{look.emoji}</span>
        <span className="font-semibold">{look.word}</span>
      </button>
      {/* The padding under the card carries the pointer from the chip to the card, so its links can be reached. */}
      <div
        id={tipId} role="tooltip" data-open={open ? '' : undefined}
        className={`invisible absolute bottom-full left-0 z-20 w-[18rem] pb-2.5 opacity-0 group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100 max-sm:left-0 max-sm:right-0 max-sm:w-auto ${open ? '!visible !opacity-100' : ''}`}
      >
        <div className="rounded-[10px] border border-line bg-panel px-3 py-2.5 text-left text-xs leading-snug text-fg shadow-[0_8px_24px_rgb(0_0_0/0.5)]">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[13px] font-bold" style={{ color: colorOf(agent.participant, participants) }}>{label}</span>
            <span className="flex flex-none items-center gap-1.5 text-muted">
              <span aria-hidden="true" className="block h-[7px] w-[7px] rounded-full" style={{ background: HEARTBEAT_COLORS[look.heartbeat] }} />{heardText(ageMs)}
            </span>
          </div>
          <p className="m-0 mt-1">
            {agent.state === 'idle' || !agent.text ? <>{agent.emoji} resting</> : <>{agent.emoji} {agent.word} «<FlightText text={agent.text} />»</>}
          </p>
          <p className="m-0 mt-1 text-muted" data-last-merge="">
            {agent.last_merge
              ? <>last merge: {REPO ? <a href={pullRequestUrl(REPO, agent.last_merge.pr)} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted underline-offset-2">PR {agent.last_merge.pr}</a> : `PR ${agent.last_merge.pr}`}, {timeOf(agent.last_merge.merged_at)}</>
              : 'no merge of its own yet'}
          </p>
          {agent.blocked && <p className="m-0 mt-1 font-semibold text-[#ff7b72]" data-blocked-on="">Blocked on {agent.blocked.on}: <FlightText text={agent.blocked.text} /></p>}
        </div>
      </div>
    </span>
  );
}

/** The chips as a row; nothing until the hub has answered, and nothing when it has no agents. */
export function HealthRow({ report, fetchedAt, now, participants = [] }: { report: HealthReport; fetchedAt: number; now: number; participants?: readonly Participant[] }) {
  if (!report.agents.length) return null;
  return (
    // Under the Guard ring; on a phone the chips take a row of their own, below the buttons.
    <span role="group" aria-label="Agent health" className="inline-flex flex-none items-center gap-1.5 max-sm:order-last max-sm:basis-full">
      {report.agents.map((a) => <HealthChip key={a.participant} agent={a} ageMs={ageNow(a, fetchedAt, now)} participants={participants} />)}
    </span>
  );
}

/** Reads GET /api/health every 15 s (not while the tab is hidden) and moves the minutes on in between. */
export function HealthChips({ api, participants = [] }: { api: ApiFn | null; participants?: readonly Participant[] }) {
  const [state, setState] = useState<{ report: HealthReport; fetchedAt: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!api) return undefined;
    let stopped = false;
    const load = async () => {
      try {
        const report = (await (await api('/api/health')).json()) as HealthReport;
        if (!stopped && Array.isArray(report.agents)) { setState({ report, fetchedAt: Date.now() }); setNow(Date.now()); }
      } catch { /* offline for a moment, or the token was refused: keep what is shown; the next poll tries again */ }
    };
    void load();
    const poll = setInterval(() => { if (!document.hidden) void load(); }, HEALTH_POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    const onVisible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { stopped = true; clearInterval(poll); clearInterval(tick); document.removeEventListener('visibilitychange', onVisible); };
  }, [api]);
  if (!state) return null;
  return <HealthRow report={state.report} fetchedAt={state.fetchedAt} now={now} participants={participants} />;
}
