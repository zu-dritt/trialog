'use client';

// The loop and cost guard on the page (the rules are in lib/guard.ts): a small ring under the
// message box that fills up with today's agent messages, and the Guard panel it opens, with a
// chart of agent messages per hour and the three figures the guard watches.
//
// The ring is green, amber from 80% of the daily limit, and red while the guard holds wake-ups
// back. The chart is drawn by hand in SVG: the page loads nothing from elsewhere.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { headsUpAt, type GuardLimit, type GuardReport } from '../lib/guard';
import { colorOf, labelOf, type Participant } from '../lib/shared';
import { StreakSection } from './streak';

/** How often the ring asks GET /api/guard. */
export const GUARD_RING_MS = 60_000;
/** How often the open panel asks. */
export const GUARD_PANEL_MS = 30_000;

export type RingLevel = 'ok' | 'warn' | 'tripped';
/** The colours of the ring: the page's own ok, decision amber and bad. */
export const RING_COLORS: Record<RingLevel, string> = { ok: '#3fb950', warn: '#d29922', tripped: '#f85149' };

/** A share from 0 to 1. A limit of 0 can't happen, but would read as full. */
export const share = (n: number, of: number): number => (of > 0 ? Math.min(1, Math.max(0, n / of)) : 1);

/** A share as a whole percent, rounded down, so «100%» means the limit is really reached. */
export const percent = (n: number, of: number): number => Math.floor(share(n, of) * 100);

export function ringLevel(report: Pick<GuardReport, 'now' | 'limits' | 'tripped'>): RingLevel {
  if (report.tripped) return 'tripped';
  return report.now.day >= headsUpAt(report.limits) ? 'warn' : 'ok';
}

/** Why wake-ups are held back, in a few words. */
export function limitText(limit: GuardLimit, limits: GuardReport['limits']): string {
  if (limit === 'in-a-row') return `${limits.inARow} agent messages in a row without a human`;
  if (limit === 'hour') return `${limits.perHour} agent messages in the last hour`;
  return `${limits.perDay} agent messages in the last 24 hours`;
}

/** What the ring says to a screen reader and on hover. */
export function ringLabel(report: Pick<GuardReport, 'now' | 'limits' | 'tripped'>): string {
  const base = `Agent messages today: ${report.now.day} of ${report.limits.perDay} (${percent(report.now.day, report.limits.perDay)}%)`;
  return report.tripped ? `${base}. Wake-ups paused: ${limitText(report.tripped, report.limits)}.` : base;
}

const RING_R = 7;
const RING_C = 2 * Math.PI * RING_R;

/** The ring. A button: a click opens or closes the Guard panel. */
export function GuardRing({ report, open, onToggle, controls }: { report: GuardReport; open: boolean; onToggle: () => void; controls?: string }) {
  const level = ringLevel(report);
  const filled = share(report.now.day, report.limits.perDay);
  const label = ringLabel(report);
  return (
    <button
      type="button" onClick={onToggle} aria-label={label} title={label}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? controls : undefined}
      className="inline-flex cursor-pointer items-center rounded-full p-1 hover:bg-[#2a2f3a]"
    >
      <svg aria-hidden="true" viewBox="0 0 18 18" width="18" height="18" className="block" data-level={level}>
        <circle cx="9" cy="9" r={RING_R} fill="none" stroke="#262a33" strokeWidth="2.5" />
        <circle
          cx="9" cy="9" r={RING_R} fill="none" stroke={RING_COLORS[level]} strokeWidth="2.5" strokeLinecap="round"
          strokeDasharray={`${(filled * RING_C).toFixed(2)} ${RING_C.toFixed(2)}`} transform="rotate(-90 9 9)"
        />
      </svg>
    </button>
  );
}

// --- the chart --------------------------------------------------------------------------------

export const CHART = { width: 300, height: 120, top: 8, bottom: 18, left: 4, right: 30 };
/** The space between two bars, and between two agents within a bar. */
const BAR_GAP = 2;
const SEGMENT_GAP = 2;

export interface ChartSegment { name: string; count: number; y: number; height: number; color: string }
export interface ChartBar { start: string; total: number; x: number; width: number; segments: ChartSegment[] }
export interface ChartLayout { bars: ChartBar[]; scale: number; limitY: number; baseline: number }

/**
 * Where every bar and every agent's part of it goes. The scale reaches at least the hourly
 * limit, so its dashed line is always on the chart. Agents are stacked in the order of the
 * roster, the first at the bottom, each in its own colour; an agent with nothing that hour has no part.
 */
export function chartLayout(report: Pick<GuardReport, 'hours' | 'limits'>, participants: readonly Participant[]): ChartLayout {
  const { width, height, top, bottom, left, right } = CHART;
  const baseline = height - bottom;
  const plot = baseline - top;
  const agents = participants.filter((p) => p.kind === 'agent').map((p) => p.name);
  // Names in the report that the page doesn't know (yet) still get stacked, after the known ones.
  const names = [...agents, ...new Set(report.hours.flatMap((h) => Object.keys(h.bySender)).filter((n) => !agents.includes(n)))];
  const totals = report.hours.map((h) => names.reduce((sum, n) => sum + (h.bySender[n] ?? 0), 0));
  const scale = Math.max(report.limits.perHour, ...totals, 1);
  const step = (width - left - right) / Math.max(1, report.hours.length);
  const bars = report.hours.map((h, i) => {
    let y = baseline;
    const segments: ChartSegment[] = [];
    for (const name of names) {
      const count = h.bySender[name] ?? 0;
      if (!count) continue;
      const full = (count / scale) * plot;
      // The gap comes out of the part above it, so a stack is as tall as its total.
      const gap = segments.length ? SEGMENT_GAP : 0;
      const part = Math.max(1, full - gap);
      y -= full;
      segments.push({ name, count, y, height: part, color: colorOf(name, participants) });
    }
    return { start: h.start, total: totals[i], x: left + i * step + BAR_GAP / 2, width: Math.max(1, step - BAR_GAP), segments };
  });
  return { bars, scale, limitY: baseline - (report.limits.perHour / scale) * plot, baseline };
}

const hourFmt = new Intl.DateTimeFormat('de-CH', { hour: '2-digit', minute: '2-digit' });
const hourOf = (iso: string): string => hourFmt.format(new Date(iso));

/** One bar's tooltip: the hour and who wrote how much. */
export function barTitle(bar: ChartBar, participants: readonly Participant[]): string {
  const who = bar.segments.map((s) => `${labelOf(s.name, participants)} ${s.count}`).join(', ');
  return `${hourOf(bar.start)}: ${bar.total ? who : 'no agent messages'}`;
}

/** Agent messages per hour for the last 24 hours, stacked by agent, with the hourly limit dashed in red. */
export function GuardChart({ report, participants }: { report: GuardReport; participants: readonly Participant[] }) {
  const layout = chartLayout(report, participants);
  const { width, height, right } = CHART;
  const agents = participants.filter((p) => p.kind === 'agent');
  const busiest = Math.max(0, ...layout.bars.map((b) => b.total));
  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${width} ${height}`} width="100%" role="img" className="block"
        aria-label={`Agent messages per hour, the last 24 hours. The busiest hour had ${busiest}; the limit is ${report.limits.perHour} an hour.`}
      >
        <line x1={0} x2={width - right} y1={layout.baseline} y2={layout.baseline} stroke="#262a33" strokeWidth="1" />
        {layout.bars.map((bar) => (
          <g key={bar.start}>
            <title>{barTitle(bar, participants)}</title>
            {/* The whole column answers the pointer, not only the coloured part. */}
            <rect x={bar.x} y={CHART.top} width={bar.width} height={layout.baseline - CHART.top} fill="transparent" />
            {bar.segments.map((s) => (
              <rect key={s.name} x={bar.x} y={s.y} width={bar.width} height={s.height} rx={Math.min(1.5, bar.width / 2)} fill={s.color} />
            ))}
          </g>
        ))}
        <line x1={0} x2={width - right} y1={layout.limitY} y2={layout.limitY} stroke="#f85149" strokeWidth="1" strokeDasharray="4 3" />
        <text x={width - right + 3} y={layout.limitY + 3} fontSize="9" fill="#8b91a0">{report.limits.perHour}/h</text>
        {layout.bars.map((bar, i) => (i % 6 === 0 ? (
          <text key={bar.start} x={bar.x} y={height - 5} fontSize="9" fill="#8b91a0">{hourOf(bar.start)}</text>
        ) : null))}
      </svg>
      {agents.length > 0 && (
        <figcaption className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
          {agents.map((p) => (
            <span key={p.name} className="inline-flex items-center gap-1">
              <span aria-hidden="true" className="inline-block h-2 w-2 rounded-sm" style={{ background: colorOf(p.name, participants) }} />
              {labelOf(p.name, participants)}
            </span>
          ))}
          <span className="inline-flex items-center gap-1">
            <span aria-hidden="true" className="inline-block w-3 border-t border-dashed border-bad" />
            limit per hour
          </span>
        </figcaption>
      )}
    </figure>
  );
}

// --- the panel --------------------------------------------------------------------------------

/** One figure: a label, the number and, when there is a limit, a small bar of how full it is. */
export function GuardFigure({ label, value, of }: { label: string; value: number; of?: number }) {
  const full = of === undefined ? null : share(value, of);
  const color = full === null ? '' : full >= 1 ? RING_COLORS.tripped : full >= 0.8 ? RING_COLORS.warn : RING_COLORS.ok;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted">{label}</span>
        <span className="tabular-nums">{of === undefined ? value : <>{value} / {of} <span className="font-semibold" style={{ color }}>{percent(value, of)}%</span></>}</span>
      </div>
      {full !== null && (
        <div className="h-1.5 overflow-hidden rounded-full bg-line" role="presentation">
          <div className="h-full rounded-full" style={{ width: `${percent(value, of!)}%`, background: color }} />
        </div>
      )}
    </div>
  );
}

/**
 * The Guard panel: what holds wake-ups back, the chart and the three figures. Escape or the
 * Close button closes it, and the focus goes back to the ring.
 */
export function GuardPanel({ id, report, error, participants, onClose, children }: {
  children?: ReactNode;
  id?: string;
  report: GuardReport | null;
  error: string;
  participants: readonly Participant[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      id={id} role="dialog" aria-label="Guard"
      className="absolute bottom-full right-2 z-20 mb-2 max-h-[75dvh] w-[min(22rem,calc(100vw-1rem))] overflow-y-auto rounded-lg border border-line bg-panel p-3 shadow-lg"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="m-0 text-sm font-semibold">Guard</h2>
        <button type="button" onClick={onClose} className="cursor-pointer rounded px-1.5 text-muted hover:text-fg" aria-label="Close the Guard panel">✕</button>
      </div>
      {error && <p className="mb-2 text-xs text-bad" role="alert">{error}</p>}
      {report ? (
        <>
          <p className="mb-2 text-xs" role="status">
            {report.tripped
              ? <><span className="font-semibold text-bad">Wake-ups paused</span>: {limitText(report.tripped, report.limits)}. Write anything to continue.</>
              : <><span className="font-semibold text-ok">Wake-ups go out.</span> They pause when an agent limit is reached.</>}
          </p>
          <GuardChart report={report} participants={participants} />
          <div className="mt-3 flex flex-col gap-2">
            <GuardFigure label="Agent messages, last 24 hours" value={report.now.day} of={report.limits.perDay} />
            <GuardFigure label="In a row without a human" value={report.now.inARow} of={report.limits.inARow} />
            <GuardFigure label="Pauses, last 24 hours" value={report.pausesToday} />
          </div>
          {children}
        </>
      ) : !error && <p className="m-0 text-xs text-muted">Loading…</p>}
    </div>
  );
}

type ApiFn = (path: string, options?: RequestInit) => Promise<Response>;

/**
 * GET /api/guard once at the start and every minute, and every 30 seconds while the panel is
 * open (and at once when it opens). `api` null: nothing is asked (a pane that isn't the leading one).
 */
export function useGuard(api: ApiFn | null, open: boolean): { report: GuardReport | null; error: string } {
  const [report, setReport] = useState<GuardReport | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!api) return undefined;
    let stopped = false;
    const load = async () => {
      try {
        const data = (await (await api('/api/guard')).json()) as GuardReport;
        if (!stopped) { setReport(data); setError(''); }
      } catch (e) {
        if (!stopped) setError(e instanceof Error && e.message !== 'unauthorized' ? `The guard could not be read: ${e.message}` : '');
      }
    };
    void load();
    const timer = setInterval(() => { void load(); }, open ? GUARD_PANEL_MS : GUARD_RING_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [api, open]);
  return { report, error };
}

/** The ring and, when it is open, the panel. The panel is placed above the composer, which must be `relative`. */
export function Guard({ api, participants }: { api: ApiFn | null; participants: readonly Participant[] }) {
  const [open, setOpen] = useState(false);
  const { report, error } = useGuard(api, open);
  const panelId = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  if (!report) return null;
  const close = () => {
    setOpen(false);
    rootRef.current?.querySelector('button')?.focus();
  };
  return (
    <span ref={rootRef} className="contents">
      <GuardRing report={report} open={open} onToggle={() => setOpen((v) => !v)} controls={panelId} />
      {open && <GuardPanel id={panelId} report={report} error={error} participants={participants} onClose={close}>{api && <StreakSection api={api} participants={participants} />}</GuardPanel>}
    </span>
  );
}
