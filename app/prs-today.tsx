'use client';

// A count chip in the message-box row: «PRs today: n/100», the day's merge goal (playground #1357,
// #1359). The number comes from GET /api/prs-today (lib/prs-today.ts). The chip stays hidden until
// a count arrives, and hides again if the count cannot be fetched and there is no last good one.
import { useEffect, useState } from 'react';
import { PRS_TODAY_GOAL, prsTodayLabel, type PrsTodayReport } from '../lib/prs-today';

/** How often the chip asks GET /api/prs-today. Matches the one-minute cache used when a token is set. */
export const PRS_TODAY_POLL_MS = 60_000;

type ApiFn = (path: string, options?: RequestInit) => Promise<Response>;

export function PrsTodayChip({ count, goal = PRS_TODAY_GOAL }: { count: number; goal?: number }) {
  return (
    <span
      data-prs-today={count}
      className="flex-none rounded-full border border-ok/60 bg-ok/10 px-2 py-0.5 text-[12px] font-semibold text-ok"
      title="Pull requests merged into this repository since midnight Europe/Zurich"
      aria-label={prsTodayLabel(count, goal)}
    >
      {prsTodayLabel(count, goal)}
    </span>
  );
}

/** Fetches GET /api/prs-today and shows the chip when a count is available. */
export function PrsTodayChips({ api }: { api: ApiFn | null }) {
  const [report, setReport] = useState<PrsTodayReport | null>(null);

  useEffect(() => {
    if (!api) return undefined;
    let stopped = false;
    const load = async () => {
      try {
        const data = (await (await api('/api/prs-today')).json()) as PrsTodayReport;
        if (stopped) return;
        if (typeof data.count === 'number') setReport(data);
        else setReport((prev) => (prev && typeof prev.count === 'number' ? prev : null));
      } catch {
        /* offline for a moment, or the token was refused: keep what is shown; the next poll tries again */
      }
    };
    void load();
    const poll = setInterval(() => { if (!document.hidden) void load(); }, PRS_TODAY_POLL_MS);
    const onVisible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { stopped = true; clearInterval(poll); document.removeEventListener('visibilitychange', onVisible); };
  }, [api]);

  if (!api || report?.count == null) return null;
  return <PrsTodayChip count={report.count} goal={report.goal ?? PRS_TODAY_GOAL} />;
}
