"use client";

import dynamic from "next/dynamic";

/**
 * MediaPipe reaches for `window` as soon as it is evaluated, so the whole game
 * shell has to be client-only. Without `ssr: false` the Next build crashes.
 */
const GameShell = dynamic(() => import("@/components/GameShell"), {
  ssr: false,
  loading: () => (
    <div className="stage">
      <div className="stage-inner grid place-items-center">
        <p className="text-foam/70 text-sm tracking-wide">Loading…</p>
      </div>
    </div>
  ),
});

export default function Page() {
  return <GameShell />;
}
