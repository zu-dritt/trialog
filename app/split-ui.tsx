'use client';

import { useEffect, useState } from 'react';
import { RoomTabs } from './rooms';
import { SPLIT_MIN_WIDTH_PX, splitFits } from './split';

const BUTTON = 'cursor-pointer rounded-md border border-line bg-[#2a2f3a] px-3 py-[5px] hover:bg-[#343a47] disabled:cursor-default disabled:opacity-50 disabled:hover:bg-[#2a2f3a]';

/** Whether the window is wide enough for two panes. Starts false, so a narrow first paint never flashes them. */
export function useSplitFits(): boolean {
  const [fits, setFits] = useState(false);
  useEffect(() => {
    const media = window.matchMedia(`(min-width: ${SPLIT_MIN_WIDTH_PX}px)`);
    const sync = () => setFits(splitFits(window.innerWidth) || media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  return fits;
}

/** The header control that turns split view on or off. */
export function SplitToggle({ on, onToggle, disabled = false, className = '' }: {
  on: boolean;
  onToggle: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const label = on ? 'Show one room' : 'Show two rooms side by side';
  return (
    <button
      type="button"
      className={`${BUTTON} ${className}`}
      aria-pressed={on}
      aria-label={label}
      title={disabled ? 'Split view needs a wider window.' : label}
      disabled={disabled}
      onClick={() => { if (!disabled) onToggle(); }}
    >
      Split
    </button>
  );
}

/**
 * The room bar at the top of each pane in split view. Both panes have the same bar at the same
 * height, so the two rooms start on one line: the room tabs, with what is new in the others, and +.
 */
export function PaneRoomBar({ side, ...tabs }: { side: 'lead' | 'side' } & React.ComponentProps<typeof RoomTabs>) {
  return (
    <div className="flex h-11 shrink-0 items-center border-b border-line px-3" aria-label={side === 'lead' ? 'Rooms, left pane' : 'Rooms, right pane'} role="group">
      <RoomTabs {...tabs} className="flex min-w-0 flex-1" />
    </div>
  );
}
