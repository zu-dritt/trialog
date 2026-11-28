'use client';

// The whole page broke, layout included: the same recovery, inside its own <html> (Next replaces the layout).
import { Recover } from './recover';

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}><Recover error={error} /></body>
    </html>
  );
}
