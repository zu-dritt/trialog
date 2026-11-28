'use client';

// A page of the hub broke: reload once (a new release), else show the cause (app/recover.tsx).
import { Recover } from './recover';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <Recover error={error} reset={reset} />;
}
