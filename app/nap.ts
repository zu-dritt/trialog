// A hub tab that stays hidden for a while stops its live stream, so the database can go to sleep
// (playground #761, David's go in #762). Each open stream asks the store once a second; a tab
// forgotten overnight kept Neon awake all night. A short look at another tab changes nothing: the
// stream naps only after NAP_AFTER_MS hidden. Back in view, it reconnects at once and catches up.

/** How long a tab may stay hidden before its stream naps. */
export const NAP_AFTER_MS = 15 * 60_000;

/** What the nap needs from `document`. */
export interface NapDocument {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface Nap {
  /** True from NAP_AFTER_MS hidden until the tab is shown again. */
  readonly napping: boolean;
  /** Resolves when the tab is awake (at once if it is), or when `signal` aborts. */
  awake(signal?: AbortSignal): Promise<void>;
  stop(): void;
}

interface Timers { setTimer: (f: () => void, ms: number) => unknown; clearTimer: (t: unknown) => void }

/** Watches the tab; calls `onNap` (to end the open stream) once it has been hidden for `afterMs`. */
export function watchNap(
  doc: NapDocument,
  onNap: () => void,
  { afterMs = NAP_AFTER_MS, setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t as ReturnType<typeof setTimeout>) }: Partial<Timers> & { afterMs?: number } = {},
): Nap {
  let napping = false;
  let timer: unknown;
  const waiters = new Set<() => void>();
  const wake = () => { for (const w of [...waiters]) w(); waiters.clear(); };
  const arm = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    if (doc.hidden && !napping) timer = setTimer(() => { timer = undefined; napping = true; onNap(); }, afterMs);
  };
  const onChange = () => {
    if (!doc.hidden && napping) { napping = false; wake(); }
    arm();
  };
  doc.addEventListener('visibilitychange', onChange);
  arm();
  return {
    get napping() { return napping; },
    awake(signal) {
      if (!napping || signal?.aborted) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const done = () => { waiters.delete(done); resolve(); };
        waiters.add(done);
        signal?.addEventListener('abort', done, { once: true });
      });
    },
    stop() {
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      doc.removeEventListener('visibilitychange', onChange);
      wake();
    },
  };
}
