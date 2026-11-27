'use client';

// The streak in the Guard panel: pull requests merged in a row without the orchestrator stepping in.
// The number now, the record to beat, a timeline that should go up and to the right, the last few
// reasons a streak ended (for the retro), and «I stepped in» with one line why. The data is in
// lib/streak.ts and GET /api/streak; anyone may end a streak, honestly (agents with hub.js).
import { useEffect, useState, type FormEvent } from 'react';
import { labelOf, type Participant } from '../lib/shared';
import type { StreakPoint, StreakReport } from '../lib/streak';

type ApiFn = (path: string, options?: RequestInit) => Promise<Response>;

export const STREAK_CHART = { width: 300, height: 90, top: 8, bottom: 14, left: 4, right: 22 };
const GREEN = '#3fb950';
const RECORD = '#c792ea';
const BREAK = '#f85149';

/** The two lines of the timeline as SVG paths: the streak as steps, and the record, which only climbs. */
export function streakPaths(points: readonly StreakPoint[], size = STREAK_CHART): { streak: string; record: string; breaks: { x: number; y: number; point: StreakPoint }[]; max: number } {
  const { width, height, top, bottom, left, right } = size;
  if (!points.length) return { streak: '', record: '', breaks: [], max: 0 };
  const max = Math.max(1, ...points.map((p) => p.record));
  const t0 = Date.parse(points[0].at);
  const t1 = Math.max(t0 + 1, Date.parse(points[points.length - 1].at));
  const x = (at: string) => left + ((Date.parse(at) - t0) / (t1 - t0)) * (width - left - right);
  const y = (v: number) => top + (1 - v / max) * (height - top - bottom);
  const f = (n: number) => n.toFixed(1);
  let streak = `M${f(x(points[0].at))},${f(y(0))}`;
  let record = `M${f(x(points[0].at))},${f(y(0))}`;
  let lastRecord = 0;
  const breaks: { x: number; y: number; point: StreakPoint }[] = [];
  for (const p of points) {
    const px = x(p.at);
    streak += ` H${f(px)} V${f(y(p.value))}`;
    if (p.record !== lastRecord) { record += ` H${f(px)} V${f(y(p.record))}`; lastRecord = p.record; }
    if (p.break) breaks.push({ x: px, y: y(p.break.ended), point: p });
  }
  const end = f(width - right);
  return { streak: `${streak} H${end}`, record: `${record} H${end}`, breaks, max };
}

/** «5 more for a new record», «a new record!», or nothing yet. */
export function toRecord(current: number, record: number): string {
  if (record === 0) return '';
  if (current >= record) return current > 0 ? 'a new record! 🏆' : '';
  return `${record - current} more for a new record`;
}

export function StreakChart({ report, participants = [] }: { report: Pick<StreakReport, 'points'>; participants?: readonly Participant[] }) {
  const { streak, record, breaks, max } = streakPaths(report.points);
  if (!streak) return null;
  const { width, height, right, top } = STREAK_CHART;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="block h-auto w-full" role="img" aria-label={`Streak timeline: the streak climbs with each merge and drops at a break; the record is ${max}.`}>
      <path d={record} fill="none" stroke={RECORD} strokeWidth="1.5" strokeDasharray="3 3" />
      <path d={streak} fill="none" stroke={GREEN} strokeWidth="2" strokeLinejoin="round" />
      {breaks.map((b) => (
        <circle key={b.point.at + b.x} cx={b.x} cy={b.y} r="3" fill={BREAK}>
          <title>{`Ended at ${b.point.break!.ended} by ${labelOf(b.point.break!.by, participants)}: ${b.point.break!.reason}`}</title>
        </circle>
      ))}
      <text x={width - right + 3} y={top + 4} fontSize="9" fill={RECORD}>{max}</text>
    </svg>
  );
}

/** «I stepped in»: one line why, then the streak ends. */
export function StepIn({ onSend }: { onSend: (reason: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  if (!open) {
    return <button type="button" onClick={() => setOpen(true)} className="cursor-pointer rounded-md border border-line bg-[#2a2f3a] px-2.5 py-1 text-xs hover:bg-[#343a47]">I stepped in…</button>;
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!reason.trim() || busy) return;
    setBusy(true);
    if (await onSend(reason.trim())) { setReason(''); setOpen(false); }
    setBusy(false);
  };
  return (
    <form onSubmit={(e) => { void submit(e); }} className="flex gap-1.5">
      <input
        autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200}
        placeholder="Why? One line, for the retro" aria-label="Why the streak ends"
        className="min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-1 text-xs"
      />
      <button type="submit" disabled={!reason.trim() || busy} className="cursor-pointer rounded-md border border-line bg-[#2a2f3a] px-2.5 py-1 text-xs hover:bg-[#343a47] disabled:opacity-50">End streak</button>
      <button type="button" onClick={() => setOpen(false)} className="cursor-pointer px-1 text-xs text-muted hover:text-fg" aria-label="Cancel">✕</button>
    </form>
  );
}

/** The whole section, as the panel shows it. */
export function StreakView({ report, participants = [], onBreak }: { report: StreakReport; participants?: readonly Participant[]; onBreak?: (reason: string) => Promise<boolean> }) {
  const ended = report.points.filter((p) => p.break).slice(-3).reverse();
  const share = report.record > 0 ? Math.min(1, report.current / report.record) : 0;
  return (
    <section aria-label="Streak" className="mt-3 border-t border-line pt-3">
      <h3 className="m-0 text-xs font-semibold">Streak: pull requests without the orchestrator stepping in</h3>
      <div className="mt-1 flex items-baseline gap-4">
        <span><span className="text-2xl font-extrabold tabular-nums" style={{ color: GREEN }} data-streak="current">{report.current}</span> <span className="text-xs text-muted">now</span></span>
        <span><span className="text-2xl font-extrabold tabular-nums" style={{ color: RECORD }} data-streak="record">{report.record}</span> <span className="text-xs text-muted">record 🏆</span></span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line" role="presentation">
        <div className="h-full rounded-full" style={{ width: `${Math.round(share * 100)}%`, background: GREEN }} />
      </div>
      {toRecord(report.current, report.record) && <p className="m-0 mt-1 text-[11px] text-muted">{toRecord(report.current, report.record)}</p>}
      <div className="mt-2"><StreakChart report={report} participants={participants} /></div>
      {ended.length > 0 && (
        <ul className="mt-2 text-[11px]" aria-label="Where the last streaks ended">
          {ended.map((p) => (
            <li key={p.at} className="truncate"><span className="font-semibold">{p.break!.ended}</span> → {p.break!.reason} <span className="text-muted">({labelOf(p.break!.by, participants)})</span></li>
          ))}
        </ul>
      )}
      {report.problem && <p className="m-0 mt-1 text-[11px] text-muted">{report.problem}</p>}
      {onBreak && <div className="mt-2"><StepIn onSend={onBreak} /></div>}
    </section>
  );
}

/** Reads GET /api/streak while the panel is open, and ends a streak with POST /api/streak/break. */
export function StreakSection({ api, participants = [] }: { api: ApiFn; participants?: readonly Participant[] }) {
  const [report, setReport] = useState<StreakReport | null>(null);
  const [error, setError] = useState('');
  const load = async () => {
    try {
      setReport((await (await api('/api/streak')).json()) as StreakReport);
      setError('');
    } catch (e) {
      setError(e instanceof Error && e.message !== 'unauthorized' ? `The streak could not be read: ${e.message}` : '');
    }
  };
  useEffect(() => { void load(); }, [api]); // eslint-disable-line react-hooks/exhaustive-deps
  const onBreak = async (reason: string) => {
    try {
      await api('/api/streak/break', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) });
      await load();
      return true;
    } catch {
      setError('The streak could not be ended. Try again.');
      return false;
    }
  };
  if (error) return <p className="m-0 mt-3 text-xs text-bad" role="alert">{error}</p>;
  if (!report) return <p className="m-0 mt-3 text-xs text-muted">Loading the streak…</p>;
  return <StreakView report={report} participants={participants} onBreak={onBreak} />;
}
