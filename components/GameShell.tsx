"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CONFIG } from "@/lib/config";
import { archetypeFor, tallyLine } from "@/lib/archetype";
import { sharePolaroid } from "@/lib/share";
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

/**
 * What the stamp on each print says, and which sprite carries it.
 *
 * The text is baked into the sprite rather than set in CSS over a blank badge:
 * the lettering is the artwork here, and a system font over a generated shape
 * reads as a caption stuck on top of a sticker rather than as one stamp.
 * If a sprite is missing the print falls back to a drawn chip — see `Stamp`.
 */
const STAMP: Record<Capture["kind"], { label: string; src: string }> = {
  catch: { label: "Caught", src: "/assets/stamp_caught.webp" },
  gulp: { label: "Ate it", src: "/assets/stamp_ate.webp" },
  mouth: { label: "Wide open", src: "/assets/stamp_open.webp" },
  tug: { label: "Head tug", src: "/assets/stamp_tug.webp" },
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
  const archetype = useMemo(
    () => archetypeFor({ caught: state.caught, caughtRare: state.caughtRare, gulps: state.gulps }),
    [state.caught, state.caughtRare, state.gulps]
  );

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
              <RecordRing pct={timePct} secondsLeft={state.timeLeft} />
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
          <div className="absolute inset-0 grid place-items-center bg-void/85 px-6 backdrop-blur-[3px]">
            <div className="w-full max-w-[72cqw] text-center">
              <h1 className="text-[9cqw] font-black uppercase leading-none tracking-tight text-foam">
                Nose Fisher
              </h1>

              <HowToPlay />

              <p className="mt-3 text-[3cqw] leading-relaxed text-foam/70">
                Move your nose to steer the line. Open your mouth to sink the hook.
                <br />
                Snap your head up to throw the fish — then catch it in your mouth.
              </p>

              <div className="mt-5">
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
                    className="rounded-full bg-splat px-10 py-4 text-[4.4cqw] font-black uppercase tracking-wide text-foam shadow-[0_6px_0_#a3125f] active:translate-y-1 active:shadow-[0_2px_0_#a3125f]"
                  >
                    Start fishing
                  </button>
                )}
              </div>

              <p className="mt-4 text-[2.6cqw] text-foam/40">
                {CONFIG.runDuration}-second take
              </p>
            </div>
          </div>
        )}

        {/* ------------------------------------------------------- RESULT */}
        {/* No opaque scrim: the final frame stays visible underneath, so this
            reads as prints laid over the scene rather than a separate screen. */}
        {state.phase === "result" && (
          <div className="absolute inset-0 bg-void/55">
            {/* The result card is laid out INSIDE the core safe zone, and it is
                positioned rather than padded: percentage padding resolves
                against the container's WIDTH, so `pb-[23.2%]` on a 9:16 stage
                buys only 13% of the height and quietly drops the CTAs below the
                zone. Percentage `top`/`bottom` resolve against height. */}
            {/* Rows are sized to CONTENT and the group is centred, rather than
                stretched across the zone. Stretching pinned the title to the
                very top and the CTA to the very bottom, which read as three
                scattered elements instead of one card.
                The middle row still needs a definite height for the print (see
                PhotoCarousel), so the print row carries its own `cqw` height
                rather than absorbing slack — that also keeps the button inside
                the core zone on a short stage, which is what the old `1fr`
                was protecting against. */}
            <div className="absolute inset-x-[var(--core-x)] top-[var(--core-top)] bottom-[var(--core-bottom)] grid grid-rows-[auto_auto_auto] content-center">
            <header className="pb-[2.4cqw] text-center">
              <h2 className="ink-title text-[9.5cqw] leading-[0.92]">{archetype.title}</h2>
              <p className="ink-tally mt-[1.6cqw] text-[3.2cqw]">{tallyLine(state)}</p>
            </header>

            <PhotoCarousel
              captures={state.captures}
              archetype={archetype.title}
              tally={tallyLine(state)}
            />

            {/* Inside a real effect the player just records again — a menu of
                CTAs is game furniture. One compact restart stays because the
                demo is opened as a link, and a reviewer who cannot replay only
                ever sees one run. Sharing lives on the print itself. */}
            <footer className="relative z-10 pt-[2.2cqw] text-center">
              <GoAgainButton onClick={handleReplay} />
              {cameraDenied && (
                <p className="mt-1.5 text-[2.4cqw] text-foam/60">
                  Playing without a camera — drag to fish.
                </p>
              )}
            </footer>
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
 * The how-to-play loop.
 *
 * A 30-second take is too short to learn in, and the mechanic — nose steers,
 * mouth pays out — is far easier to show than to write. The loop teaches it
 * before the camera is ever switched on.
 *
 * The art is not made yet, so this renders a placeholder until
 * `/assets/howto.gif` exists; dropping the file in is the whole handoff.
 */
function HowToPlay() {
  const [hasLoop, setHasLoop] = useState(true);
  const loopRef = useRef<HTMLImageElement>(null);

  // Same pre-hydration caveat as the stamp: check the decoded state on mount.
  useEffect(() => {
    const el = loopRef.current;
    if (el && el.complete && el.naturalWidth === 0) setHasLoop(false);
  }, []);

  return (
    <div className="mx-auto mt-4 w-full max-w-[54cqw]">
      <div className="relative aspect-[4/5] w-full overflow-hidden rounded-2xl border-2 border-dashed border-surface/30 bg-void/70">
        {hasLoop ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            ref={loopRef}
            src="/assets/howto.gif"
            alt="How to play"
            className="h-full w-full object-cover"
            onError={() => setHasLoop(false)}
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-4 text-center">
            <span className="text-[3cqw] font-black uppercase tracking-[0.3em] text-surface/60">
              How to play
            </span>
            <span className="text-[2.4cqw] font-semibold text-foam/35">
              loop goes here
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The run clock, drawn as a record ring rather than a progress bar.
 *
 * This is a 30-second take inside a camera effect, not a level with a time
 * limit. A depleting ring around a blinking dot says "you are being recorded";
 * a bar sliding to empty says "you are running out of game".
 */
function RecordRing({ pct, secondsLeft }: { pct: number; secondsLeft: number }) {
  const R = 44;
  const C = 2 * Math.PI * R;
  return (
    <div className="pointer-events-none absolute left-0 top-0 flex items-center gap-[2cqw]">
      <div className="relative h-[10cqw] w-[10cqw]">
        <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
          <circle cx="50" cy="50" r={R} fill="rgba(13,7,34,0.55)" />
          <circle
            cx="50"
            cy="50"
            r={R}
            fill="none"
            stroke="rgba(242,236,255,0.22)"
            strokeWidth="9"
          />
          <circle
            cx="50"
            cy="50"
            r={R}
            fill="none"
            stroke="#ff2d9b"
            strokeWidth="9"
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - pct)}
          />
        </svg>
        <span
          className="absolute left-1/2 top-1/2 h-[2.6cqw] w-[2.6cqw] -translate-x-1/2 -translate-y-1/2 rounded-full bg-splat"
          style={{ animation: "recBlink 1s steps(1, end) infinite" }}
        />
      </div>
      <span className="text-[3.4cqw] font-black tabular-nums text-foam drop-shadow">
        {Math.ceil(Math.max(0, secondsLeft))}s
      </span>
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

/**
 * The run's prints, as a carousel.
 *
 * One print at a time, full size, with its neighbours peeking in behind. The
 * earlier scatter pile showed all four at once but none of them large enough
 * to actually read — and the share action needs an unambiguous subject, which
 * a pile does not have.
 *
 * Positioning is transform-only against the focused index rather than native
 * scroll: `body` sets `touch-action: none` to stop iOS bouncing the playfield,
 * which also kills a scroll-snap container. A swipe handler is the honest way
 * to get the gesture back.
 */
function PhotoCarousel({
  captures,
  archetype,
  tally,
}: {
  captures: Capture[];
  archetype: string;
  tally: string;
}) {
  // Catches and gulps lead — they are what the player actually earned.
  const ordered = useMemo(() => {
    const rank = (c: Capture) => (c.kind === "gulp" ? 0 : c.kind === "catch" ? 1 : 2);
    return captures.slice().sort((a, b) => rank(a) - rank(b) || a.id - b.id);
  }, [captures]);

  const [index, setIndex] = useState(0);
  const dragX = useRef<number | null>(null);

  useEffect(() => {
    setIndex(0);
  }, [ordered]);

  const clamp = useCallback(
    (i: number) => Math.max(0, Math.min(ordered.length - 1, i)),
    [ordered.length]
  );

  const onDown = (e: React.PointerEvent) => {
    dragX.current = e.clientX;
  };
  const onUp = (e: React.PointerEvent) => {
    if (dragX.current === null) return;
    const dx = e.clientX - dragX.current;
    dragX.current = null;
    // 24px is past a tap but short of a deliberate scroll — one flick moves
    // exactly one print.
    if (Math.abs(dx) > 24) setIndex((i) => clamp(i + (dx < 0 ? 1 : -1)));
  };

  if (ordered.length === 0) {
    return (
      <div className="flex min-h-0 items-center justify-center">
        <p className="rounded-2xl bg-void/80 px-5 py-4 text-center text-[2.8cqw] text-foam/80">
          No photos this take — get the hook up by your face and pull a face.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-rows-[auto_auto]">
      {/* `isolate` scopes the per-print z-indexes to this row. Without it a
          positioned print with `z-index: 2` paints over the dots and the CTA —
          which sit later in the DOM but are unpositioned, so they lose the
          stacking contest no matter where they are on screen. */}
      <div
        className="relative isolate h-[68cqw] max-h-full touch-none"
        onPointerDown={onDown}
        onPointerUp={onUp}
        onPointerCancel={() => (dragX.current = null)}
      >
        {ordered.map((c, i) => {
          const offset = i - index;
          const active = offset === 0;
          return (
            <div
              key={c.id}
              className="print absolute inset-0 grid place-items-center"
              style={{
                transform: `translateX(${offset * 70}%) scale(${active ? 1 : 0.82})`,
                opacity: Math.abs(offset) > 1 ? 0 : active ? 1 : 0.45,
                zIndex: active ? 2 : 1,
                pointerEvents: active ? "auto" : "none",
              }}
            >
              <Print
                capture={c}
                active={active}
                archetype={archetype}
                tally={tally}
              />
            </div>
          );
        })}
      </div>

      {ordered.length > 1 && (
        <div className="relative z-10 flex items-center justify-center gap-[1.6cqw] pt-[1.6cqw]">
          {ordered.map((c, i) => (
            <button
              key={c.id}
              aria-label={`Photo ${i + 1}`}
              onClick={() => setIndex(i)}
              className={`h-[1.6cqw] rounded-full transition-all ${
                i === index ? "w-[5cqw] bg-foam" : "w-[1.6cqw] bg-foam/35"
              }`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** One print: photo, stamp, and — on the focused one — the share action. */
function Print({
  capture,
  active,
  archetype,
  tally,
}: {
  capture: Capture;
  active: boolean;
  archetype: string;
  tally: string;
}) {
  const stamp = STAMP[capture.kind];
  const [sharing, setSharing] = useState(false);

  const onShare = async () => {
    if (sharing) return;
    setSharing(true);
    try {
      await sharePolaroid({
        photo: capture.src,
        stamp: stamp.src,
        stampLabel: stamp.label,
        archetype,
        tally,
      });
    } finally {
      setSharing(false);
    }
  };

  return (
    // The card is sized off the available HEIGHT — the vertical budget is the
    // scarce one once the safe zones take their cut — so it is the GRID item
    // directly, with `width: auto` derived from `aspect-ratio`.
    //
    // It used to be a flex item nested inside another flex row, and Safari
    // collapsed it to a sliver: the photo is absolutely positioned (so it
    // contributes no intrinsic width) and `min-width: 0` let everything else
    // shrink to nothing, leaving Safari to resolve the width from content
    // rather than from the ratio. A grid item resolves `aspect-ratio` against
    // its definite height in both engines. `min-w-[28cqw]` is the floor: if a
    // browser ever fails to derive the width at all, the card comes out narrow
    // rather than invisible.
    <div className="relative flex h-full max-h-full w-auto min-w-[28cqw] max-w-full flex-col rounded-[4px] bg-foam p-[1.6cqw] pb-[6cqw] shadow-2xl [aspect-ratio:44/64]">
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-void">
          {/*
            Absolutely positioned, and that is load-bearing: a captured frame is
            360x640, and an in-flow image contributes its intrinsic width to the
            flex chain's automatic minimum size. The card would then be forced at
            least 360px wide, `aspect-ratio` would stretch its height to match,
            and it would overflow its row and cover the dots and the CTA. Out of
            flow, the photo contributes nothing and the card is sized purely by
            the height available to it.
          */}
          {/* Data URLs, so next/image would only get in the way. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={capture.src}
            alt={stamp.label}
            className="absolute inset-0 h-full w-full object-cover"
          />
        </div>

        {/* Keyed on `active` so the flight replays every time this print
            becomes the focused one, not just on first mount. */}
        <Stamp key={String(active)} label={stamp.label} src={stamp.src} animate={active} />

        <div className="absolute inset-x-[1.6cqw] bottom-[1.2cqw] flex items-center justify-between">
          <span className="text-[2.2cqw] font-black uppercase tracking-[0.18em] text-void/45">
            Nose Fisher
          </span>
          {active && (
            <button
              onClick={onShare}
              aria-label="Share this photo"
              className="grid h-[6.4cqw] w-[6.4cqw] place-items-center rounded-full bg-splat text-foam shadow-[0_2px_0_#a3125f] active:translate-y-[1px] active:shadow-none disabled:opacity-60"
              disabled={sharing}
            >
              <ShareIcon />
            </button>
          )}
        </div>
    </div>
  );
}

/**
 * Replay, as a sticker rather than a UI button.
 *
 * The wordmark carries its own heavy outline and fill, so there is no pill
 * behind it — a chip would fight the lettering the same way a frame fought the
 * caught-list glyphs. The press is expressed as a squash, which is what a
 * sticker being pushed would do.
 *
 * Falls back to the plain pill if the sprite is missing, so the run is always
 * replayable even before the art lands.
 */
function GoAgainButton({ onClick }: { onClick: () => void }) {
  const [ok, setOk] = useState(true);
  const ref = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el && el.complete && el.naturalWidth === 0) setOk(false);
  }, []);

  if (!ok) {
    return (
      <button
        onClick={onClick}
        className="rounded-full bg-splat px-7 py-2.5 text-[3.2cqw] font-black uppercase tracking-wide text-foam shadow-[0_4px_0_#a3125f] active:translate-y-1 active:shadow-[0_1px_0_#a3125f]"
      >
        Go Again
      </button>
    );
  }

  return (
    <button
      onClick={onClick}
      aria-label="Go again"
      className="inline-block w-[26cqw] origin-bottom transition-transform duration-100 active:scale-[0.94]"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={ref}
        src="/assets/btn_go_again.webp"
        alt="Go again"
        className="w-full drop-shadow-[0_3px_6px_rgba(0,0,0,0.45)]"
        onError={() => setOk(false)}
      />
    </button>
  );
}

/**
 * The corner stamp. The sprite carries its own lettering; the chip below is
 * only what shows if that sprite has not been made yet, so a missing asset
 * degrades to something readable instead of a broken image.
 */
function Stamp({ label, src, animate }: { label: string; src: string; animate: boolean }) {
  const [ok, setOk] = useState(true);
  const imgRef = useRef<HTMLImageElement>(null);

  // `onError` only catches failures React was mounted for. An image that 404s
  // before hydration finishes never fires it, and the print keeps a broken
  // icon where the stamp should be — so the decoded state is checked once on
  // mount as well.
  useEffect(() => {
    const el = imgRef.current;
    if (el && el.complete && el.naturalWidth === 0) setOk(false);
  }, []);
  return (
    <div className={`stamp${animate ? " stamp-fly" : ""}`}>
      {ok ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={imgRef}
          src={src}
          alt={label}
          className="w-full drop-shadow-[0_2px_4px_rgba(0,0,0,0.35)]"
          onError={() => setOk(false)}
        />
      ) : (
        <span className="block rounded-md border-[0.5cqw] border-void bg-splat px-[1.6cqw] py-[0.8cqw] text-center text-[2.6cqw] font-black uppercase leading-tight text-foam">
          {label}
        </span>
      )}
    </div>
  );
}

function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-[60%] w-[60%]" fill="none" aria-hidden>
      <path
        d="M12 3v12M12 3l-4 4M12 3l4 4"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
