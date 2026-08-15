"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CONFIG } from "@/lib/config";
import type { Game, GameSnapshotState } from "@/lib/game";

type Loading = "idle" | "loading" | "ready" | "failed";

const INITIAL: GameSnapshotState = {
  phase: "title",
  timeLeft: CONFIG.runDuration,
  caught: 0,
  usedMouth: false,
  showMouthHint: false,
  inputMode: "face",
  snapshot: null,
};

export default function GameShell() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const gameRef = useRef<Game | null>(null);

  const [state, setState] = useState<GameSnapshotState>(INITIAL);
  const [loading, setLoading] = useState<Loading>("idle");
  const [cameraDenied, setCameraDenied] = useState(false);

  // ---- boot: construct the engine and preload MediaPipe on the title screen
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    let game: Game | null = null;

    (async () => {
      // Dynamic import keeps every `window` reference out of the server bundle.
      const { Game: GameCtor } = await import("@/lib/game");
      if (disposed) return;

      game = new GameCtor(canvas);
      game.onState = (s) => setState(s);
      gameRef.current = game;
      game.start();

      setLoading("loading");
      const res = await game.preload();
      if (disposed) return;
      setLoading(res.ok ? "ready" : "failed");
    })();

    return () => {
      disposed = true;
      game?.destroy();
      gameRef.current = null;
    };
  }, []);

  // ---- touch fallback ------------------------------------------------------
  const normalizePointer = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    };
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      const p = normalizePointer(e);
      gameRef.current?.setTouch(p.x, p.y);
    },
    [normalizePointer]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (e.buttons === 0 && e.pointerType === "mouse") return;
      const p = normalizePointer(e);
      gameRef.current?.setTouch(p.x, p.y);
    },
    [normalizePointer]
  );

  const onPointerUp = useCallback(() => {
    gameRef.current?.setTouch(null, null);
  }, []);

  // ---- start ---------------------------------------------------------------
  const handleStart = useCallback(async () => {
    const game = gameRef.current;
    const video = videoRef.current;
    if (!game || !video) return;

    // Camera + audio must both be kicked off inside this gesture for iOS.
    const gotCamera = await game.initCamera(video);
    setCameraDenied(!gotCamera);
    await game.startRun();
  }, []);

  const handleReplay = useCallback(async () => {
    await gameRef.current?.startRun();
  }, []);

  const timePct = Math.max(0, state.timeLeft / CONFIG.runDuration);

  return (
    <div className="stage">
      <div className="stage-inner">
        <canvas
          ref={canvasRef}
          className="stage-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />

        {/* iOS Safari forces fullscreen playback without playsInline + muted. */}
        <video
          ref={videoRef}
          className="cam-video"
          playsInline
          muted
          autoPlay
        />

        {/* ---------------------------------------------------------- HUD */}
        {state.phase === "playing" && (
          <>
            <div className="pointer-events-none absolute left-4 top-4 flex items-center gap-2 rounded-full bg-black/35 px-3 py-2 backdrop-blur-sm">
              <CatchPips n={state.caught} />
            </div>

            <div className="pointer-events-none absolute right-4 top-4 h-2 w-24 overflow-hidden rounded-full bg-black/35">
              <div
                className="h-full rounded-full bg-amber transition-[width] duration-200 ease-linear"
                style={{ width: `${timePct * 100}%` }}
              />
            </div>

            {state.showMouthHint && (
              <div className="pointer-events-none absolute inset-x-0 bottom-24 flex justify-center px-8">
                <p className="float rounded-full bg-black/55 px-5 py-3 text-center text-base font-semibold text-foam backdrop-blur-sm">
                  {state.inputMode === "face"
                    ? "Open your mouth to let the line out"
                    : "Drag toward the bottom to let the line out"}
                </p>
              </div>
            )}
          </>
        )}

        {/* -------------------------------------------------------- TITLE */}
        {state.phase === "title" && (
          <div className="absolute inset-0 grid place-items-center bg-deep/80 px-8 backdrop-blur-[2px]">
            <div className="text-center">
              <h1 className="text-4xl font-extrabold tracking-tight text-foam">
                Nose Fisher
              </h1>
              <p className="mt-3 text-sm leading-relaxed text-foam/70">
                Move your nose to steer the line.
                <br />
                Open your mouth to sink the hook.
              </p>

              <div className="mt-8">
                {loading === "loading" && (
                  <div className="flex flex-col items-center gap-3">
                    <div className="h-1.5 w-40 overflow-hidden rounded-full bg-foam/15">
                      <div className="h-full w-1/3 animate-[floatY_1.2s_ease-in-out_infinite] rounded-full bg-teal" />
                    </div>
                    <p className="text-xs text-foam/50">Loading face tracking…</p>
                  </div>
                )}

                {loading === "failed" && (
                  <p className="mb-4 text-xs text-amber/80">
                    Face tracking unavailable — you can play by dragging instead.
                  </p>
                )}

                {(loading === "ready" || loading === "failed") && (
                  <button
                    onClick={handleStart}
                    className="rounded-full bg-coral px-10 py-4 text-lg font-bold text-deep shadow-lg active:scale-95"
                  >
                    Start fishing
                  </button>
                )}
              </div>

              <p className="mt-6 text-[11px] text-foam/40">
                {CONFIG.runDuration}-second run
              </p>
            </div>
          </div>
        )}

        {/* ------------------------------------------------------- RESULT */}
        {state.phase === "result" && (
          <div className="absolute inset-0 grid place-items-center bg-deep/85 px-6 backdrop-blur-[2px]">
            <div className="w-full max-w-[300px] text-center">
              <ResultFrame src={state.snapshot} />

              <p className="mt-5 text-3xl font-extrabold text-foam">
                {state.caught} {state.caught === 1 ? "fish" : "fish"}
              </p>
              <p className="mt-1 text-sm text-foam/60">
                {state.caught === 0 ? "The one that got away." : "Nice haul."}
              </p>

              <button
                onClick={handleReplay}
                className="mt-7 rounded-full bg-coral px-9 py-3.5 text-base font-bold text-deep shadow-lg active:scale-95"
              >
                Go again
              </button>

              {cameraDenied && (
                <p className="mt-4 text-[11px] text-foam/40">
                  Playing without a camera — drag to fish.
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ------------------------------------------------------- ROTATE */}
      <div className="rotate-overlay">
        <div className="px-10">
          <p className="text-2xl font-bold text-foam">Turn your phone upright</p>
          <p className="mt-2 text-sm text-foam/60">This one is played in portrait.</p>
        </div>
      </div>
    </div>
  );
}

/** The catch counter. Deliberately pips, not a score. */
function CatchPips({ n }: { n: number }) {
  if (n === 0) {
    return <span className="text-xs font-semibold text-foam/50">No catches yet</span>;
  }
  if (n <= 6) {
    return (
      <div className="flex items-center gap-1">
        {Array.from({ length: n }).map((_, i) => (
          <FishPip key={i} />
        ))}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <FishPip />
      <span className="text-sm font-bold text-foam">×{n}</span>
    </div>
  );
}

function FishPip() {
  return (
    <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden>
      <path
        d="M10 6c0 2.2-2 4-4.5 4S1 8.2 1 6s2-4 4.5-4S10 3.8 10 6Z"
        fill="#ff6b4a"
        stroke="#1a1410"
        strokeWidth="1.2"
      />
      <path
        d="M10 6l4.5-2.6v5.2L10 6Z"
        fill="#ff6b4a"
        stroke="#1a1410"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <circle cx="4.4" cy="5.2" r="0.9" fill="#1a1410" />
    </svg>
  );
}

/** Result card frame, drawn with CSS rather than a generated sprite. */
function ResultFrame({ src }: { src: string | null }) {
  return (
    <div className="relative mx-auto aspect-[9/16] w-full max-h-[46vh] overflow-hidden rounded-2xl border-[6px] border-foam bg-black/40 shadow-2xl">
      {src ? (
        // A data URL, so next/image would only get in the way here.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="Your catch" className="h-full w-full object-cover" />
      ) : (
        <div className="grid h-full w-full place-items-center">
          <p className="px-6 text-center text-xs text-foam/50">
            No snapshot this run — hook a fish and fight it to get one.
          </p>
        </div>
      )}
      <div className="pointer-events-none absolute inset-0 rounded-xl ring-2 ring-inset ring-teal/40" />
    </div>
  );
}
