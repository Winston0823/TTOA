"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CONFIG } from "@/lib/config";
import type { Capture, CatchEntry, Game, GameSnapshotState } from "@/lib/game";

type Loading = "idle" | "loading" | "ready" | "failed";

const INITIAL: GameSnapshotState = {
  phase: "title",
  timeLeft: CONFIG.runDuration,
  caught: 0,
  caughtRare: 0,
  catches: [],
  usedMouth: false,
  showMouthHint: false,
  gulps: 0,
  submerged: false,
  inputMode: "face",
  captures: [],
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
            {/* Timer and caught list both live in the visual-content zone:
                informational, and tolerant of edge occlusion. */}
            <div className="safe-visual">
              <div className="pointer-events-none absolute left-0 top-0 h-[1.6cqw] w-[26cqw] overflow-hidden rounded-full bg-void/60">
                <div
                  className="h-full rounded-full bg-surface transition-[width] duration-200 ease-linear"
                  style={{ width: `${timePct * 100}%` }}
                />
              </div>

              <CaughtList catches={state.catches} />
            </div>

            {/* Submerged outranks the mouth hint: while the player's face is
                under the waterline nothing they do with their mouth can land a
                fish, so telling them to open it would be actively misleading. */}
            {state.submerged ? (
              <div className="safe-core pointer-events-none flex items-end justify-center pb-2">
                <p className="float rounded-full bg-splat px-5 py-3 text-center text-base font-bold text-foam">
                  {state.inputMode === "face"
                    ? "You're underwater — sit up to fish"
                    : "Drag higher — the line is underwater"}
                </p>
              </div>
            ) : (
              state.showMouthHint && (
                <div className="safe-core pointer-events-none flex items-end justify-center pb-2">
                  <p className="float rounded-full bg-void/75 px-5 py-3 text-center text-base font-semibold text-foam ring-1 ring-surface/30 backdrop-blur-sm">
                    {state.inputMode === "face"
                      ? "Open your mouth to let the line out"
                      : "Drag toward the bottom to let the line out"}
                  </p>
                </div>
              )
            )}
          </>
        )}

        {/* -------------------------------------------------------- TITLE */}
        {state.phase === "title" && (
          <div className="absolute inset-0 grid place-items-center bg-void/85 px-8 backdrop-blur-[3px]">
            <div className="w-full max-w-[66cqw] text-center">
              <h1 className="text-4xl font-extrabold tracking-tight text-foam">
                Nose Fisher
              </h1>
              <p className="mt-3 text-sm leading-relaxed text-foam/70">
                Move your nose to steer the line.
                <br />
                Open your mouth to sink the hook.
                <br />
                Snap your head up to throw the fish —
                <br />
                then catch it in your mouth.
              </p>

              <div className="mt-8">
                {loading === "loading" && (
                  <div className="flex flex-col items-center gap-3">
                    <div className="h-1.5 w-40 overflow-hidden rounded-full bg-foam/15">
                      <div className="h-full w-1/3 animate-[floatY_1.2s_ease-in-out_infinite] rounded-full bg-surface" />
                    </div>
                    <p className="text-xs text-foam/50">Loading face tracking…</p>
                  </div>
                )}

                {loading === "failed" && (
                  <p className="mb-4 text-xs text-gold/85">
                    Face tracking unavailable — you can play by dragging instead.
                  </p>
                )}

                {(loading === "ready" || loading === "failed") && (
                  <button
                    onClick={handleStart}
                    className="rounded-full bg-splat px-10 py-4 text-lg font-black uppercase tracking-wide text-foam shadow-[0_6px_0_#a3125f] active:translate-y-1 active:shadow-[0_2px_0_#a3125f]"
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
        {/* No opaque scrim: the final frame stays visible underneath and the
            prints scatter across it, so this reads as photos tossed onto the
            scene rather than a separate screen. */}
        {state.phase === "result" && (
          <div className="absolute inset-0 flex flex-col bg-void/45">
            <div className="shrink-0 px-5 pt-5">
              <p className="text-4xl font-black uppercase tracking-tight text-foam drop-shadow-[0_2px_0_rgba(18,10,32,0.6)]">
                Score
              </p>
              <p className="mt-1 text-sm font-bold text-foam drop-shadow">
                {state.caught} fish
                {state.caughtRare > 0 && (
                  <span className="text-gold"> · {state.caughtRare} rare</span>
                )}
                {state.gulps > 0 && (
                  <span className="text-splat"> · {state.gulps} eaten</span>
                )}
              </p>
            </div>

            <PhotoScatter captures={state.captures} />

            <div className="shrink-0 px-6 pb-7 pt-2 text-center">
              <button
                onClick={handleReplay}
                className="rounded-xl bg-splat px-10 py-3.5 text-base font-black uppercase tracking-wide text-foam shadow-[0_6px_0_#a3125f] active:translate-y-1 active:shadow-[0_2px_0_#a3125f]"
              >
                Go Again
              </button>
              {cameraDenied && (
                <p className="mt-3 text-[11px] text-foam/60">
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

/**
 * The caught list — a vertical rail of every fish landed this run, newest at
 * the top, down the right edge of the visual-content safe zone.
 *
 * Sizing follows the TikTok effect spec's own list frame: 68x44 glyphs on a
 * 54px pitch, against the 390x694 effect canvas. Expressed in cqw so the rail
 * scales with the stage instead of the viewport.
 *
 * Rarity is the only thing the fill encodes: magenta common, gold rare. It is
 * a list, not a score — no number is attached to an entry.
 */
function CaughtList({ catches }: { catches: CatchEntry[] }) {
  const VISIBLE = 6;
  // Newest first. When the run outruns the rail the oldest fall off, so the
  // most recent catch is never the one pushed out of view.
  const shown = [...catches].reverse().slice(0, VISIBLE);
  const overflow = catches.length - shown.length;

  // Each id chomps exactly once. Without this the animation would replay on
  // every re-render for as long as the entry stayed on the rail.
  const chomped = useRef<Set<number>>(new Set());
  const toChomp = new Set<number>();
  for (const c of catches) {
    if (c.gulped && !chomped.current.has(c.id)) {
      toChomp.add(c.id);
      chomped.current.add(c.id);
    }
  }

  return (
    <div className="absolute right-0 top-0 flex flex-col items-end gap-[2.4cqw]">
      {shown.map((c, i) => (
        <CaughtSlot
          key={c.id}
          rarity={c.rarity}
          gulped={c.gulped}
          chomping={toChomp.has(c.id)}
          // Only the newest entry slides in; re-animating the whole column on
          // every catch reads as a glitch rather than an addition.
          fresh={i === 0 && !c.gulped}
        />
      ))}
      {overflow > 0 && (
        <span className="text-[2.8cqw] font-bold text-foam/70 drop-shadow">+{overflow}</span>
      )}
    </div>
  );
}

function CaughtSlot({
  rarity,
  gulped,
  chomping,
  fresh,
}: {
  rarity: CatchEntry["rarity"];
  gulped: boolean;
  chomping: boolean;
  fresh: boolean;
}) {
  const rare = rarity === "rare";
  return (
    <div
      // 17.4cqw ≈ the spec's 68px glyph on a 390px canvas. No frame — the
      // glyph carries its own outline, and a chip would fight the camera feed.
      className={`relative grid h-[11.3cqw] w-[17.4cqw] place-items-center ${
        fresh ? "animate-[slotIn_260ms_cubic-bezier(0.2,1.4,0.4,1)]" : ""
      }`}
    >
      {/* Mouth first in the DOM so it renders BEHIND the fish — the fish sits
          inside the open lips rather than having a jaw stuck to its side. */}
      {gulped && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src="/assets/mouth.webp"
          alt=""
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 w-[14cqw] -translate-x-1/2 -translate-y-1/2"
          style={
            chomping
              ? { animation: "chompBite 640ms cubic-bezier(0.3,1.2,0.4,1) forwards" }
              : undefined
          }
        />
      )}

      <div
        className="relative grid h-full w-full place-items-center"
        style={
          chomping
            ? { animation: "chompFish 640ms cubic-bezier(0.3,1.2,0.4,1) forwards" }
            : gulped
              ? { transform: "scale(0.6)" }
              : undefined
        }
      >
        <FishPip rare={rare} />
      </div>
    </div>
  );
}

function FishPip({ rare = false }: { rare?: boolean }) {
  const fill = rare ? "#ffd23d" : "#ff2d9b";
  return (
    <svg viewBox="0 0 16 12" className="h-full w-full drop-shadow-[0_1px_2px_rgba(0,0,0,0.55)]" aria-hidden>
      {/* Angular, to match the ink sprites rather than a rounded icon set. */}
      <path
        d="M1 6l3-3.4 5.2-1L11 6l-1.8 4.4-5.2-1L1 6Z"
        fill={fill}
        stroke="#120a20"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M11 6l4.2-2.8-.6 5.6L11 6Z"
        fill={fill}
        stroke="#120a20"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <circle cx="4.6" cy="5.4" r="1" fill="#120a20" />
    </svg>
  );
}

const KIND_LABEL: Record<Capture["kind"], string> = {
  catch: "Caught",
  gulp: "Ate it",
  mouth: "Wide open",
  tug: "Head tug",
};

/**
 * Deterministic per-photo jitter.
 *
 * Seeded off the capture id rather than Math.random, so a print does not leap
 * to a new angle on every React re-render — the pile has to sit still.
 */
function jitter(id: number) {
  const wobble = (salt: number) => {
    const v = Math.sin(id * 12.9898 + salt) * 43758.5453;
    return v - Math.floor(v); // 0..1
  };
  return {
    rotate: (wobble(1) - 0.5) * 22,
    dx: (wobble(2) - 0.5) * 18,
    dy: (wobble(3) - 0.5) * 14,
  };
}

/**
 * The run's photos, tossed across the final frame as a pile of prints.
 * Tapping one lifts it rather than opening a viewer, so browsing never leaves
 * the card.
 */
function PhotoScatter({ captures }: { captures: Capture[] }) {
  // Catches and gulps lead. This is a wrapping layout, so order IS position —
  // sorting them last would bury the earned shots beneath everything else.
  const ordered = useMemo(() => {
    const rank = (c: Capture) =>
      c.kind === "gulp" ? 0 : c.kind === "catch" ? 1 : 2;
    return captures.slice().sort((a, b) => rank(a) - rank(b) || a.id - b.id);
  }, [captures]);

  const [raisedId, setRaisedId] = useState<number | null>(null);

  if (ordered.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-10">
        <p className="rounded-2xl bg-void/80 px-5 py-4 text-center text-xs text-foam/80">
          No photos this run — get the hook up by your face and pull a face.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-3 py-2">
      <div className="flex flex-wrap justify-center">
        {ordered.map((c, i) => {
          const j = jitter(c.id);
          const raised = c.id === raisedId;
          const earned = c.kind === "catch" || c.kind === "gulp";
          return (
            <button
              key={c.id}
              onClick={() => setRaisedId(raised ? null : c.id)}
              aria-label={KIND_LABEL[c.kind]}
              // Negative margins are what make the prints overlap into a pile
              // rather than sit in a tidy grid.
              className="relative -mx-2 -my-1 w-[43%] shrink-0 transition-transform active:scale-95"
              style={{
                transform: `rotate(${j.rotate}deg) translate(${j.dx}px, ${j.dy}px) scale(${raised ? 1.08 : 1})`,
                // Earned shots also sit on top where prints overlap, so a
                // neighbour never clips the one photo that mattered.
                zIndex: raised ? 9999 : (earned ? 1000 : 0) + i,
              }}
            >
              <div className="rounded-[3px] bg-foam p-1.5 pb-5 shadow-xl">
                <div className="relative aspect-[9/13] w-full overflow-hidden bg-void">
                  {/* Data URLs, so next/image would only get in the way. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={c.src}
                    alt={KIND_LABEL[c.kind]}
                    className="h-full w-full object-cover"
                  />
                </div>
                <span className="absolute inset-x-0 bottom-1 text-center text-[9px] font-bold uppercase tracking-wide text-void/70">
                  {c.kind === "gulp"
                    ? "😋 Ate it"
                    : c.kind === "catch"
                      ? "🐟 Caught"
                      : KIND_LABEL[c.kind]}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
