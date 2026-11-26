import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

/** The hub's name in the browser tab. `HUB_NAME` tells deployments apart, e.g. «Trialog Playground». */
const hubName = () => process.env.HUB_NAME?.trim().slice(0, 60) || 'Trialog';

export const metadata: Metadata = {
  title: hubName(),
  description: 'One shared chat for a human and two AI agents',
  robots: { index: false, follow: false },
};

// The page may reach the edges of a phone's screen (viewport-fit=cover), so that iOS reports the
// notch and the home bar as safe-area insets. The page pads itself by those insets (app/page.tsx).
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
