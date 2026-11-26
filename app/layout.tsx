import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

/** The hub's name in the browser tab. `HUB_NAME` tells deployments apart, e.g. «Trialog Playground». */
const hubName = () => process.env.HUB_NAME?.trim().slice(0, 60) || 'Trialog';

export const metadata: Metadata = {
  title: hubName(),
  description: 'One shared chat for a human and two AI agents',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
