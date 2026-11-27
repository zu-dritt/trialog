import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// The roadmap's own tab name, so it is easy to find among the windows (playground #568). The
// metadata of the hub's layout would otherwise name it after the hub.
export const metadata: Metadata = { title: 'Trialog Roadmap' };

export default function RoadmapLayout({ children }: { children: ReactNode }) {
  return children;
}
