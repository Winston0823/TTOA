"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CONFIG } from "@/lib/config";
import { archetypeFor, tallyLine } from "@/lib/archetype";
import { sharePolaroid } from "@/lib/share";
import type { Capture, CatchEntry, Game, GamePulse, GameSnapshotState } from "@/lib/game";

type Loading = "idle" | "loading" | "ready" | "failed";

const INITIAL: GameSnapshotState = {
  phase: "title",
  timeLeft: CONFIG.runDuration,
  caught: 0,
  caughtRare: 0,
  score: 0,
  catches: [],
  usedMouth: false,
  showMouthHint: false,
  gulps: 0,
  submerged: false,
  inputMode: "face",
  captures: [],
  tracking: false,
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

const M = CONFIG.motion;

/**
 * Keeps a screen mounted for `ms` after it stops being active, so it can play
 * an exit rather than vanishing on the frame the phase flips.
 *
 * Returns `"in"` while active, `"out"` during the grace period, and `null` once
 * it should really be gone. Two of the three phase changes are user-initiated
 * and can simply be sequenced by hand in the handler; this exists for the one
 * that is not — the run ending on its own clock, deep inside the game loop.
 */
function useExitLatch(active: boolean, ms: number): "in" | "out" | null {
  const [state, setState] = useState<"in" | "out" | null>(active ? "in" : null);

  useEffect(() => {
    if (active) {
      setState("in");
      return;
    }
    // `setState` in the cleanup-free branch would strand a screen that was
    // never shown, so only latch out if something was actually on screen.
    let cancelled = false;
    setState((prev) => (prev === null ? null : "out"));
    const id = setTimeout(() => {
      if (!cancelled) setState(null);
    }, ms);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [active, ms]);

  return state;
}

/**
 * Counts a number up from zero.
 *
 * The result total should be watched arriving, not read on arrival — the number
 * is the whole verdict of the run, and a value that is simply present when the
 * screen appears is the one thing on this screen with no moment of its own.
 *
 * Eased out, so it sprints and then lands rather than crawling linearly to the
 * final digit. Negative totals count DOWN through zero for the same reason.
 */
function useCountUp(target: number, ms: number, enabled: boolean): number {
  const [value, setValue] = useState(enabled ? 0 : target);

  useEffect(() => {
    if (!enabled) {
      setValue(target);
      return;
    }
    if (target === 0) {
      setValue(0);
      return;
    }
    let raf = 0;
    let start: number | null = null;
    const step = (ts: number) => {
      if (start === null) start = ts;
      const t = Math.min(1, (ts - start) / ms);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(target * eased));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms, enabled]);

  return value;
}

/** True when the OS asks for less motion. Read once — it is not a live toggle. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
  }, []);
  return reduced;
}

/** A score number in flight, from where it was earned to the counter. */
type Pop = { id: number; points: number; x: number; y: number };

/**
 * Where a pop is heading: the centre of the HUD score.
 *
 * X is in cqw; Y is too, which is why it looks small — the stage is 9:16, so
 * the full height is 177.8cqw and the counter's centre sits about 26 of them
 * down. Measured against the same safe-zone percentages the counter is laid out
 * with, rather than read from the DOM: a `getBoundingClientRect` per catch is a
 * forced layout in the one moment of the run that has to hold 60fps.
 */
const POP_TARGET_X = 90;
const POP_TARGET_Y = 26;
/** The stage is 9:16, so 100cqw of width is 177.8cqw of height. */
const STAGE_H_CQW = (100 * 16) / 9;

/**
 * Score numbers in flight, from the fish that earned them to the counter.
 *
 * Four nested elements, and each layer exists because a CSS animation REPLACES
 * the element's whole `transform` for as long as it runs:
 *
 *   1. position — `left`/`top` percentages, NOT a transform. Putting the start
 *      point in `transform` meant the keyframe overwrote it the instant the
 *      animation began, and every number jumped to the stage's top-left corner
 *      before flying off from there.
 *   2. the X leg of the arc.
 *   3. the Y leg. Splitting the axes across two elements, each with its own
 *      easing, is what makes the path a parabola — one element can only tween a
 *      straight line between two translates, which reads as a tooltip sliding
 *      rather than as something thrown.
 *   4. centring on the point, which has to live below both animations for the
 *      same overwrite reason.
 */
function ScorePops({ pops }: { pops: Pop[] }) {
  return (
    <>
      {pops.map((p) => {
        const fromX = p.x * 100;
        const fromY = p.y * STAGE_H_CQW;
        return (
          <span
            key={p.id}
            className="absolute block"
            style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
          >
            <span
              className="block will-change-transform"
              style={{
                animation: `popArcX ${M.popFlight}ms cubic-bezier(0.4, 0, 0.7, 0.5) forwards`,
                ["--pop-dx" as string]: `${POP_TARGET_X - fromX}cqw`,
              }}
            >
              <span
                className="block"
                style={{
                  animation: `popArcY ${M.popFlight}ms cubic-bezier(0.3, 0, 0.6, 1) forwards`,
                  ["--pop-dy" as string]: `${POP_TARGET_Y - fromY}cqw`,
                }}
              >
                <span
                  className={`ink-hud block -translate-x-1/2 -translate-y-1/2 whitespace-nowrap text-[7cqw] leading-none ${
                    p.points < 0 ? "ink-hud-damage" : "ink-hud-score"
                  }`}
                >
                  {p.points > 0 ? `+${p.points}` : p.points}
                </span>
              </span>
            </span>
          </span>
        );
      })}
    </>
  );
}

export default function GameShell() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const gameRef = useRef<Game | null>(null);

  const [state, setState] = useState<GameSnapshotState>(INITIAL);
  const [loading, setLoading] = useState<Loading>("idle");
  const [cameraDenied, setCameraDenied] = useState(false);

  // ---- motion ---------------------------------------------------------------
  const reduced = useReducedMotion();
  /** Numbers currently in flight from a fish to the counter. */
  const [pops, setPops] = useState<Pop[]>([]);
  /** The stage, kicked imperatively on a catch — see the note on the element. */
  const stageRef = useRef<HTMLDivElement>(null);
  /** The wind-up beat that last fired, or null. Keyed so each one replays. */
  const [bite, setBite] = useState<{ id: number; n: number } | null>(null);
  /**
   * The start sequence.
   *
   *   idle     — the title, waiting to be tapped
   *   clearing — the title is animating out while the camera is being opened
   *   waiting  — the title is gone and the camera is STILL not producing frames
   *
   * The third state exists because the exit is 300ms and opening a camera on a
   * mid-range Android is routinely 1-3 SECONDS. Without it the animation
   * finishes into an empty stage and the player is looking at nothing, which is
   * a worse answer than the hitch it replaced.
   */
  const [starting, setStarting] = useState<"idle" | "preparing" | "clearing">("idle");
  const titleLeaving = starting === "clearing";
  const [resultLeaving, setResultLeaving] = useState(false);
  const popId = useRef(0);

  /**
   * The whole-stage kick on a catch.
   *
   * Deliberately tiny — 1.2% and a hair of rotation. A real shake, on a camera
   * feed the player is simultaneously trying to aim their face at, is nausea
   * rather than impact.
   *
   * Driven through the Web Animations API rather than a CSS class because a
   * finished CSS animation does not replay just because its class is still
   * applied, and the usual fix — changing the element's key — would remount the
   * canvas and the video out from under the engine. `animate()` always starts
   * fresh and leaves the tree alone.
   *
   * `container-type: inline-size` on this element is unaffected: cqw resolves
   * against the content box, which a transform does not change.
   */
  const kickStage = useCallback(() => {
    const el = stageRef.current;
    if (!el || reduced || typeof el.animate !== "function") return;
    el.animate(
      [
        { transform: "scale(1) rotate(0deg)" },
        { transform: "scale(1.012) rotate(-0.22deg)", offset: 0.35 },
        { transform: "scale(0.997) rotate(0.1deg)", offset: 0.7 },
        { transform: "scale(1) rotate(0deg)" },
      ],
      { duration: M.stageKick, easing: "cubic-bezier(0.3, 1.2, 0.5, 1)" }
    );
  }, [reduced]);

  /** Turns a game event into motion. */
  const handlePulse = useCallback((p: GamePulse) => {
    if (p.kind === "tick") {
      setBite({ id: popId.current++, n: p.n });
      return;
    }

    // A zero-point event still happened, but a floating `+0` is noise.
    if (p.points !== 0) {
      const id = popId.current++;
      setPops((prev) => [...prev, { id, points: p.points, x: p.x, y: p.y }]);
      // Culled on a timer rather than `onAnimationEnd`: a backgrounded tab
      // never fires the event, and the list would grow for as long as it
      // stayed hidden.
      window.setTimeout(() => {
        setPops((prev) => prev.filter((q) => q.id !== id));
      }, M.popFlight + 80);
    }

    // The kick is for landing a fish, not for the sting of eating a puffer —
    // a hit you regret should not feel like an impact you earned.
    if (p.points > 0) kickStage();
  }, [kickStage]);

  /**
   * The engine is constructed once, in a mount-only effect, so it cannot hold
   * `handlePulse` directly: that would freeze the first render's closure, and
   * this one closes over `reduced`. It calls through this ref instead, which is
   * kept pointed at the current handler.
   */
  /** The in-flight `preload()`, so the start tap can wait on it. */
  const preloadRef = useRef<Promise<{ ok: boolean }> | null>(null);

  const pulseRef = useRef(handlePulse);
  useEffect(() => {
    pulseRef.current = handlePulse;
  }, [handlePulse]);

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
      game.onPulse = (p) => pulseRef.current(p);
      gameRef.current = game;
      game.start();

      setLoading("loading");
      // Held so the start tap can await the SAME promise rather than polling a
      // flag. A player who taps while this is in flight is queued behind it.
      const pending = game.preload();
      preloadRef.current = pending;
      const res = await pending;
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
  /**
   * Tap → spinner → everything ready → clear the title → start the run.
   *
   * The player may tap before the face model has finished downloading (~6MB
   * from two third-party CDNs, and the button is deliberately not gated on it).
   * Rather than starting the run on drag control and swapping to face control
   * underneath them, the tap WAITS: the button becomes a spinner and the run
   * begins only once the camera is delivering frames and the model is loaded.
   * A take is thirty seconds, and one that starts before its controls work is
   * worse than one that starts a second later.
   *
   * `initCamera` is called first and not awaited, because the camera has to be
   * requested inside this gesture for iOS. The model is awaited alongside it,
   * not after it, so the two overlap.
   */
  const handleStart = useCallback(async () => {
    const game = gameRef.current;
    const video = videoRef.current;
    if (!game || !video || starting !== "idle") return;

    setStarting("preparing");

    const gotCamera = await Promise.all([
      // Camera + audio must both be kicked off inside this gesture for iOS.
      game.initCamera(video),
      // Resolved, not rejected, on failure — `preload` reports through its
      // return value, and a model that never arrives falls back to drag rather
      // than stranding the player on a spinner.
      preloadRef.current ?? Promise.resolve({ ok: false }),
    ]).then(([camera]) => camera);

    setCameraDenied(!gotCamera);

    setStarting("clearing");
    await new Promise<void>((r) => setTimeout(r, reduced ? 0 : M.titleOut));

    await game.startRun();
    setStarting("idle");
  }, [reduced, starting]);

  // Go Again lands on the title screen rather than straight into a run. It is
  // the only place the how-to loop lives, so a player who missed a step gets to
  // re-read it — and routing through Start Fishing means the next run always
  // re-acquires the camera inside a fresh user gesture.
  const handleGoAgain = useCallback(() => {
    setResultLeaving(true);
    window.setTimeout(
      () => {
        setCameraDenied(false);
        gameRef.current?.backToTitle();
        setResultLeaving(false);
      },
      reduced ? 0 : M.titleOut
    );
  }, [reduced]);

  const timePct = Math.max(0, state.timeLeft / CONFIG.runDuration);
  const archetype = useMemo(
    () =>
      archetypeFor({
        caught: state.caught,
        caughtRare: state.caughtRare,
        gulps: state.gulps,
        score: state.score,
      }),
    [state.caught, state.caughtRare, state.gulps, state.score]
  );

  // The HUD is the one screen whose exit is not user-initiated — the run ends on
  // its own clock, inside the game loop — so it is the one that needs latching
  // to survive its own unmount long enough to leave.
  const hud = useExitLatch(state.phase === "playing", M.hudOut);

  // Counts up only while the result is actually on screen, so a re-render on
  // the title screen does not quietly restart it from zero.
  const shownScore = useCountUp(
    state.score,
    M.countUp,
    state.phase === "result" && !reduced && !resultLeaving
  );

  return (
    <div className="stage">
      {/*
        NEVER key this element.

        The kick has to replay on every catch, and the usual way to restart a
        finished CSS animation is to change the element's key — but keying this
        one remounts the whole subtree, and two of its children are held by
        direct reference outside React: the engine keeps the `<canvas>` and its
        2D context from construction, and the camera stream is attached to the
        `<video>`. A remount hands React a fresh canvas while the game carries on
        drawing into the detached original, so the stage goes black with the HUD
        still live on top of it, and the camera feed is orphaned at the same
        time.

        The kick is driven imperatively through the Web Animations API instead —
        see `kickStage`. `element.animate()` always starts a new animation, so it
        needs no retrigger hack and touches nothing in the tree.
      */}
      <div ref={stageRef} className="stage-inner">
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

        {/* ------------------------------------------------- SCORE POPS */}
        {/* Outside the HUD block: a number thrown on the last frame of a run
            should finish its flight, not be cut off by the clock hitting zero. */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <ScorePops pops={pops} />
        </div>

        {/* --------------------------------------------- BITE ANTICIPATION */}
        {bite && state.phase === "playing" && (
          <span
            key={bite.id}
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              // Tighter and brighter on each of the three beats, so the third —
              // the one the catch window opens on — is the loudest.
              ["--bite-peak" as string]: `${0.22 + bite.n * 0.16}`,
              boxShadow: `inset 0 0 ${14 - bite.n * 3}cqw ${
                2 + bite.n
              }cqw rgba(141, 232, 255, 0.55)`,
              animation: "bitePulse 300ms ease-out forwards",
            }}
          />
        )}

        {/* ---------------------------------------------------------- HUD */}
        {hud && (
          <>
            {/* Clock and score both live in the visual-content zone:
                informational, and tolerant of edge occlusion. Opposite corners,
                because they answer different questions — how long is left, and
                how you are doing — and a player scanning for one should never
                have to read past the other. */}
            <div
              className={`safe-visual ${hud === "out" ? "motion-hud-out" : "motion-hud-in"}`}
            >
              <RecordRing pct={timePct} secondsLeft={state.timeLeft} />
              <ScoreCounter score={state.score} />
            </div>

            {/* Submerged outranks the mouth hint: while the player's face is
                under the waterline nothing they do with their mouth can land a
                fish, so telling them to open it would be actively misleading.

                There is deliberately no "still loading" hint here any more —
                the run cannot start until the model has resolved, so a player
                on drag control is one whose camera or model FAILED, and the
                title screen has already said so. */}
            {state.phase === "playing" && state.submerged ? (
              <div className="safe-core pointer-events-none flex items-end justify-center pb-2">
                <p className="float rounded-full bg-splat px-5 py-3 text-center text-base font-bold text-foam">
                  {state.inputMode === "face"
                    ? "You're underwater — sit up to fish"
                    : "Drag higher — the line is underwater"}
                </p>
              </div>
            ) : (
              state.phase === "playing" &&
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
          <div
            className={`absolute inset-0 bg-void/85 backdrop-blur-[3px] ${
              titleLeaving ? "motion-scrim-out" : ""
            }`}
          >
            {/*
              Laid out against the PRE-RECORD safe zone, not the recording one
              the HUD and the result card use. Everything on this screen has to
              be read and tapped before the take begins, and TikTok's pre-take
              chrome claims more of the bottom than its recording chrome does —
              see the `--pre-*` note in globals.css.

              Three sections, each its own surface: what you do, what it is
              worth, and the commitment. The middle row is the only one allowed
              to absorb slack, so the legend and the CTA keep their space on a
              short stage and the how-to art gives ground instead.
            */}
            <div
              className={`absolute inset-x-[var(--pre-x)] top-0 bottom-[var(--pre-bottom)] grid grid-rows-[24.9cqw_minmax(0,1fr)_auto] gap-[2.8cqw] text-center ${
                titleLeaving ? "motion-screen-out" : "motion-screen-in"
              }`}
            >
              {/*
                The title is artwork, not set type — the lockup carries its own
                ink outline, cream inner stroke and spark marks, and a lean that
                a text treatment cannot reproduce.

                Sized by HEIGHT with the width left to follow, because height
                is the scarce resource on this screen. This row is `auto` inside
                a grid whose middle row absorbs every bit of slack, and the
                how-to art in that row is sized `h-full w-auto` — so a cqw taken
                here comes straight off the illustration, on both axes at once.

                Do NOT pin the width and cap the height instead: `w-[Ncqw]` with
                a `max-h` letterboxes a 1.5:1 lockup inside a much wider box, so
                the art paints far smaller than the space it claims.
              */}
              <h1 className="flex min-h-0 items-center justify-center pt-[4.5cqw] pb-[1.5cqw]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/assets/logo_title.webp"
                  alt="Fisherman's Nose"
                  draggable={false}
                  className="max-h-full w-auto"
                />
              </h1>

              <section className="panel grid min-h-0 p-[2cqw]">
                <HowToPlay />
              </section>

              <div className="grid gap-[2.4cqw]">
                <section className="panel px-[2cqw] py-[0.9cqw]">
                  <ScoreLegend />
                </section>

                <div>
                  {/*
                    The button is ALWAYS here now. It used to be replaced by a
                    "Loading face tracking…" bar until ~6MB of WASM and model had
                    come down from two third-party CDNs — which on a slow phone
                    is fifteen seconds of dead screen, and reads as the camera
                    being broken rather than as a download in progress. Dragging
                    is a complete way to play, so the wait is optional and the
                    note below says what starting early costs.
                  */}
                  {loading === "failed" && (
                    <p className="mb-[1.6cqw] text-[2.4cqw] text-gold/85">
                      Face tracking unavailable — you can play by dragging instead.
                    </p>
                  )}

                  {/*
                    The button is replaced by a spinner IN PLACE, at the same
                    height, so the panel above it does not jump when the swap
                    happens — this row is `auto` in a grid whose middle row
                    absorbs slack, and a height change here would resize the
                    how-to art mid-tap.
                  */}
                  {starting === "preparing" ? (
                    <StartSpinner />
                  ) : (
                    <StartButton onClick={handleStart} />
                  )}

                  <p className="mt-[0.7cqw] text-[2.3cqw] font-black uppercase tracking-[0.14em] text-foam/40">
                    {starting === "preparing"
                      ? loading === "loading"
                        ? "Getting face tracking ready…"
                        : "Starting the camera…"
                      : `${CONFIG.runDuration}-second take`}
                  </p>
                </div>
              </div>
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
            {/* `grid-rows-[auto_minmax(0,1fr)_auto]`, not a flex column: the
                middle row is the only one allowed to absorb slack, so the
                header and the CTA always keep their space. Under flex the
                carousel could out-grow its share on a short stage and push the
                button out of view — which is what made it flicker. */}
            <div
              className={`absolute inset-x-[var(--core-x)] top-[var(--core-top)] bottom-[var(--core-bottom)] grid grid-rows-[auto_minmax(0,1fr)_auto] ${
                resultLeaving ? "motion-screen-out" : "motion-screen-in"
              }`}
            >
            {/*
              The score leads, and everything under it is a caption on it.

              The number is the comparable thing — the one a player reads first,
              repeats, and tries to beat — so it gets the size. The archetype is
              the shareable thing rather than the legible one, and it survives
              being demoted because it is already printed large on the polaroid.
              The `3 FISH · 1 RARE · 3 EATEN` tally was the receipt for both, and
              a receipt is a thing you consult, not a thing you read at the end
              of a 30-second take — it still goes out on the shared print, where
              there is time for it.

              What that buys is height, and the height goes to the prints: the
              card is sized off the row it sits in, so a shorter header is a
              bigger photo.
            */}
            <header className="pb-[3.4cqw] text-center">
              {/* The unit sits UNDER the number rather than beside it, so the
                  number is optically centred on the stage instead of being
                  pushed off-axis by a suffix — and so its centre does not move
                  when the score goes from one digit to two, or picks up a
                  minus. The unit is a label on the number, not a value beside
                  it, and stacking says that more plainly than a size jump on
                  the same line did. */}
              <p className="ink-tally text-[17cqw] leading-[0.82]">{shownScore}</p>
              <p className="ink-tally mt-[0.6cqw] text-[4.4cqw] leading-none">
                {Math.abs(state.score) === 1 ? "pt" : "pts"}
              </p>
              {/* 4.4cqw, not 5.2: sized so the LONGEST archetype
                  ("Commercial Trawler") clears the safe zone on one line with
                  room for the ink stroke, which paints outside the line box. At
                  5.2 it measured wider than the zone itself. Short titles
                  reading small is correct — this is a caption on the score now,
                  and it is already printed large on the polaroid. */}
              <h2 className="ink-title ink-title-sub mt-[1.6cqw] text-[4.4cqw] leading-[1]">
                {archetype.title}
              </h2>
            </header>

            <PhotoCarousel
              captures={state.captures}
              score={state.score}
              archetype={archetype.title}
              tally={tallyLine(state)}
            />

            {/* Inside a real effect the player just records again — a menu of
                CTAs is game furniture. One compact restart stays because the
                demo is opened as a link, and a reviewer who cannot replay only
                ever sees one run. Sharing lives on the print itself. */}
            <footer className="relative z-10 pt-[2.2cqw] text-center">
              <GoAgainButton onClick={handleGoAgain} />
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
 * Seven panels, hard-cut and swipeable, with the caption as live text rather
 * than baked into the art. That is the whole reason this is a component and
 * not one animated file: reordering the steps, retiming them or translating a
 * caption is a one-line change instead of a re-render and a re-upload. Cuts,
 * not crossfades — a dissolve turns to mush at this size.
 *
 * A 30-second take is too short to learn in, and the controls are far easier
 * to show than to write. This runs before the camera is ever switched on.
 */
const HOW_TO: { src: string; caption: string }[] = [
  { src: "/assets/howto_1.webp", caption: "Move your head to aim" },
  { src: "/assets/howto_2.webp", caption: "Stay above the water to fish" },
  { src: "/assets/howto_3.webp", caption: "Open your mouth to drop the line" },
  { src: "/assets/howto_4.webp", caption: "Close it to reel back in" },
  { src: "/assets/howto_5.webp", caption: "Three ticks, then it bites" },
  { src: "/assets/howto_6.webp", caption: "Snap your head up to throw" },
  { src: "/assets/howto_7.webp", caption: "Catch it in your mouth" },
];

/** Milliseconds each panel holds. Long enough to read the caption once. */
const HOW_TO_HOLD = 4500;

/**
 * How far a drag has to travel before it counts as a swipe: a share of the
 * panel width, with a floor so the gesture stays reachable on a narrow phone.
 */
const SWIPE_RATIO = 0.15;
const SWIPE_FLOOR = 36;

/** Slop before a drag commits to an axis, so a tap never nudges the carousel. */
const SWIPE_SLOP = 6;

type Swipe = { id: number; x: number; y: number; axis: "none" | "x" };

function HowToPlay() {
  const [step, setStep] = useState(0);
  /** Whether the panel that just became current still owes its punch. */
  const [punching, setPunching] = useState(false);
  const [hasArt, setHasArt] = useState(true);
  const [drag, setDrag] = useState(0);
  const [dragging, setDragging] = useState(false);
  // Bumped on every manual move. It is a dependency of the autoplay effect and
  // nothing else, so a hand-picked panel tears the interval down and starts a
  // fresh one — you get a whole hold to read it, not the tail of someone
  // else's. Autoplay itself never switches off; swiping steers the loop rather
  // than taking it over.
  const [beat, setBeat] = useState(0);
  const probe = useRef<HTMLImageElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const swipe = useRef<Swipe | null>(null);

  useEffect(() => {
    setPunching(true);
  }, [step]);

  const nudge = useCallback((dir: number) => {
    setBeat((b) => b + 1);
    setStep((i) => (i + dir + HOW_TO.length) % HOW_TO.length);
  }, []);

  const jump = useCallback((i: number) => {
    setBeat((b) => b + 1);
    setStep(i);
  }, []);

  useEffect(() => {
    // Held still while a finger is down: advancing out from under a drag in
    // progress fights the person doing it.
    if (dragging) return;
    const id = setInterval(() => setStep((i) => (i + 1) % HOW_TO.length), HOW_TO_HOLD);
    return () => clearInterval(id);
  }, [beat, dragging]);

  // Same pre-hydration caveat as the stamps: an image that 404s before React
  // mounts never fires `onError`, so the decoded state is checked directly.
  useEffect(() => {
    const el = probe.current;
    if (el && el.complete && el.naturalWidth === 0) setHasArt(false);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    swipe.current = { id: e.pointerId, x: e.clientX, y: e.clientY, axis: "none" };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const s = swipe.current;
    if (!s || s.id !== e.pointerId) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (s.axis === "none") {
      if (Math.abs(dx) < SWIPE_SLOP && Math.abs(dy) < SWIPE_SLOP) return;
      // A first move that is mostly vertical is the page being scrolled, not
      // the carousel being driven. Bow out and leave the gesture to the page.
      if (Math.abs(dy) >= Math.abs(dx)) {
        swipe.current = null;
        setDrag(0);
        return;
      }
      s.axis = "x";
      setDragging(true);
    }
    setDrag(dx);
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const s = swipe.current;
      swipe.current = null;
      setDrag(0);
      setDragging(false);
      if (!s || s.id !== e.pointerId || s.axis !== "x") return;
      const dx = e.clientX - s.x;
      const width = stage.current?.clientWidth ?? 0;
      if (Math.abs(dx) >= Math.max(SWIPE_FLOOR, width * SWIPE_RATIO)) nudge(dx < 0 ? 1 : -1);
    },
    [nudge],
  );

  const onPointerCancel = useCallback(() => {
    swipe.current = null;
    setDrag(0);
    setDragging(false);
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "ArrowRight") nudge(1);
      else if (e.key === "ArrowLeft") nudge(-1);
      else return;
      e.preventDefault();
    },
    [nudge],
  );

  if (!hasArt) {
    return (
      <div className="grid min-h-0 place-items-center">
        <div className="grid aspect-[4/5] w-[54cqw] place-items-center rounded-2xl border-2 border-dashed border-surface/30 bg-void/70">
          <span className="text-[3cqw] font-black uppercase tracking-[0.3em] text-surface/60">
            How to play
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-[1.2cqw]">
      <div
        ref={stage}
        role="group"
        aria-roledescription="carousel"
        aria-label="How to play"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onKeyDown={onKeyDown}
        // `touch-pan-y` keeps a vertical scroll native while claiming the
        // horizontal axis, so the browser never fights the swipe handler.
        className="relative min-h-0 cursor-grab touch-pan-y select-none outline-none active:cursor-grabbing"
      >
        {HOW_TO.map((s, i) => (
          // All seven stay mounted and stacked, so the browser decodes them
          // once up front — a panel that has to load on its own beat flashes
          // empty.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={s.src}
            ref={i === 0 ? probe : undefined}
            src={s.src}
            alt={s.caption}
            draggable={false}
            style={{
              opacity: i === step ? 1 : 0,
              // A fraction of the travel, not all of it: enough for the drag
              // to feel connected without pretending the cut is a slide.
              transform: `translateX(${drag * 0.28}px)`,
              transition: drag ? "none" : "transform 180ms ease-out",
            }}
            // The cut stays a cut — a dissolve mushes at this size — but a cut
            // with NO motion at all is indistinguishable from a dropped frame,
            // so the incoming panel gets a scale punch.
            //
            // Retriggered by moving the class rather than by re-keying: these
            // seven images stay mounted precisely so the browser decodes them
            // once up front, and a changing key would remount and re-decode the
            // one panel the player is looking at.
            className={`absolute inset-0 mx-auto h-full w-auto max-w-full object-contain drop-shadow-[0_4px_10px_rgba(0,0,0,0.5)] ${
              i === step && punching ? "motion-cut-punch" : ""
            }`}
            onAnimationEnd={() => setPunching(false)}
            onError={i === 0 ? () => setHasArt(false) : undefined}
          />
        ))}
      </div>

      <div>
        <p className="min-h-[4.4cqw] px-[1.5cqw] text-[3.1cqw] font-black uppercase leading-tight tracking-wide text-foam">
          {HOW_TO[step].caption}
        </p>
        <div className="mt-[0.4cqw] flex items-center justify-center">
          {HOW_TO.map((s, i) => (
            // The dot is 1.2cqw of ink inside a much larger button — the
            // negative margin buys a thumb-sized target without adding height.
            <button
              key={s.src}
              type="button"
              onClick={() => jump(i)}
              aria-label={`Step ${i + 1}: ${s.caption}`}
              aria-current={i === step}
              className="-my-[1.6cqw] grid place-items-center px-[0.7cqw] py-[1.6cqw]"
            >
              <span
                className={`h-[1.2cqw] rounded-full transition-all ${
                  i === step ? "w-[4cqw] bg-splat" : "w-[1.2cqw] bg-foam/30"
                }`}
              />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * What counts, as a legend rather than another panel in the loop.
 *
 * A player needs three things before the take starts: that gold is worth more
 * than magenta, that eating one on the way down doubles it, and that the cyan
 * one bites back. All three read at a glance here. A legend is always on
 * screen and costs nothing to skip, which a fourth beat in the how-to loop
 * would not be.
 *
 * The puffer carries both its numbers — `2 / −3` — because the penalty is the
 * only rule in the game that can move the score backwards, and finding that
 * out by losing five points is a bad way to learn it.
 *
 * Built from the pieces already in the game — the same fish sprites the water
 * uses, and the same mouth sprite — so it cannot drift from what the player
 * will actually see.
 */
function ScoreLegend() {
  return (
    <div className="flex items-center justify-center gap-[4.5cqw]">
      <LegendItem label="Common" value="1">
        <FishPip />
      </LegendItem>

      <LegendItem label="Rare" value="3">
        <FishPip species="rare" />
      </LegendItem>

      <LegendItem label="Puffer" value="2 / −3" warn>
        <FishPip species="puffer" />
      </LegendItem>

      <LegendItem label="Eaten" value="×2">
        <span className="relative grid h-full w-full place-items-center">
          {/* Mouth behind the fish, so the bite reads as lips closing over it
              rather than a jaw stuck to its side. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/assets/mouth.webp"
            alt=""
            aria-hidden
            className="absolute left-1/2 top-1/2 w-[6.2cqw] -translate-x-1/2 -translate-y-1/2"
          />
          <span className="relative block w-[3.6cqw]">
            <FishPip />
          </span>
        </span>
      </LegendItem>
    </div>
  );
}

function LegendItem({
  label,
  value,
  warn = false,
  children,
}: {
  label: string;
  /** Points this entry is worth, as displayed. */
  value?: string;
  /** Renders the value in gold — used for the entry that can cost you. */
  warn?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span className="flex flex-col items-center gap-[0.4cqw]">
      <span className="grid h-[6.6cqw] w-[6.2cqw] place-items-center">{children}</span>
      <span className="text-[2cqw] font-black uppercase tracking-[0.14em] text-foam/55">
        {label}
      </span>
      {value && (
        <span
          className={`text-[2.2cqw] font-black tabular-nums ${
            warn ? "text-gold" : "text-foam/80"
          }`}
        >
          {value}
        </span>
      )}
    </span>
  );
}

/**
 * How many seconds left before the clock starts pulsing. Short enough that it
 * is a last call rather than a countdown running under the whole take.
 */
const URGENT_AT = 5;

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
  const secs = Math.ceil(Math.max(0, secondsLeft));
  const urgent = secs <= URGENT_AT && secs > 0;
  return (
    <div className="pointer-events-none absolute left-0 top-0 flex items-center gap-[1.4cqw]">
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
          {/* The depleting arc, which on the first frame of a run also draws
              itself closed — the take has not started until the ring is whole.
              `--ring-c` hands the circumference to the keyframe, which cannot
              read it from the attribute. */}
          <circle
            className="motion-ring-draw"
            cx="50"
            cy="50"
            r={R}
            fill="none"
            stroke="#ff2d9b"
            strokeWidth="9"
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - pct)}
            style={{ ["--ring-c" as string]: C }}
          />
        </svg>
        <span
          className="absolute left-1/2 top-1/2 h-[2.6cqw] w-[2.6cqw] -translate-x-1/2 -translate-y-1/2 rounded-full bg-splat"
          style={{ animation: "recBlink 1s steps(1, end) infinite" }}
        />
      </div>
      <span
        className={`ink-hud ink-hud-clock text-[3.4cqw] ${
          urgent ? "ink-hud-clock-urgent" : ""
        }`}
      >
        {secs}s
      </span>

    </div>
  );
}

/**
 * The score.
 *
 * The clock is the effect's FRAME; this is the game inside it. They used to sit
 * adjacent in the same cream at the same weight, split only by a hairline and a
 * size jump — which read as one number pair, `17s | 4`, with nothing saying
 * which was which. Now they hold opposite corners, and the difference in size
 * and colour does the labelling.
 *
 * Anchored to the RIGHT edge, and right-aligned, so the number grows leftwards.
 * A centred or left-anchored counter shifts sideways as it crosses from one
 * digit to two, and a number that moves while you are looking away from it is
 * a number you have to re-find. The gold is the same gold the result screen
 * sets its points in: the number that is gold at the end of a run is the number
 * that was gold during it.
 */
function ScoreCounter({ score }: { score: number }) {
  return (
    <div className="pointer-events-none absolute right-0 top-0 text-right">
      {/*
        Two nested elements because two animations have to run at once and CSS
        gives an element one `animation` property. The outer one is struck every
        time the value changes; the inner carries the sting on a swing into
        negative. Nesting also keeps the punch's `scale` from being composed
        away by the sting's `translateX`.

        Both are keyed, not classed: an animation that has already finished does
        not replay because a class is still present, so the key is what makes
        the second catch move at all.
      */}
      <span key={`punch-${score}`} className="motion-score-punch block origin-top-right">
        <span
          key={score < 0 ? "neg" : "pos"}
          className={`ink-hud block text-[12cqw] leading-[0.9] ${
            score < 0 ? "ink-hud-score-neg" : "ink-hud-score"
          }`}
        >
          {score}
        </span>
      </span>
    </div>
  );
}

/**
 * A fish in the UI — the game's own sprite, not a stand-in for it.
 *
 * These are the exact files `render.ts` paints into the water, so the legend
 * cannot drift from what the player is actually looking at, and the browser has
 * them decoded already.
 *
 * Sized by WIDTH, with the height left to follow. The two sprites do not share
 * a bounding box — the common fish carries motion ticks above and below that
 * make it near square, while the rare one is half again as wide as it is tall.
 * Fitting both into one box would bind them on height and render the rare fish
 * visibly bigger for no reason a player could name. Matching widths matches the
 * bodies, which is the thing being compared.
 */
const PIP_SRC: Record<CatchEntry["rarity"], string> = {
  common: "/assets/fish_common.webp",
  rare: "/assets/fish_rare.webp",
  // The legend shows the puffer calm. It only inflates in the water, and a
  // spiky ball at pip size reads as a smudge.
  puffer: "/assets/puffer_calm.webp",
};

function FishPip({ species = "common" }: { species?: CatchEntry["rarity"] }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={PIP_SRC[species]}
      alt=""
      aria-hidden
      draggable={false}
      className="h-auto w-full drop-shadow-[0_1px_2px_rgba(0,0,0,0.55)]"
    />
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
  score,
  archetype,
  tally,
}: {
  captures: Capture[];
  score: number;
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
    <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto]">
      {/* `isolate` scopes the per-print z-indexes to this row. Without it a
          positioned print with `z-index: 2` paints over the dots and the CTA —
          which sit later in the DOM but are unpositioned, so they lose the
          stacking contest no matter where they are on screen. */}
      <div
        className="relative isolate min-h-0 touch-none"
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
              className={`print absolute inset-0 grid place-items-center ${
                active ? "" : "print-neighbour"
              }`}
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
                score={score}
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
  score,
  archetype,
  tally,
}: {
  capture: Capture;
  active: boolean;
  score: number;
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
        score,
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
          {/* One line, always. The mark is five characters longer than the
              name it replaced and at the old size and tracking it wrapped,
              which pushed the second line through the bottom of the print. */}
          <span className="whitespace-nowrap text-[1.85cqw] font-black uppercase tracking-[0.1em] text-void/45">
            Fisherman&rsquo;s Nose
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
/**
 * The primary CTA, as a sticker rather than a pill — same reasoning as
 * GO AGAIN: the wordmark carries its own ink outline and cream border, so a
 * chip behind it would only fight the lettering.
 *
 * Sized by WIDTH here (unlike the title lockup) because this sits in the
 * grid's bottom `auto` row, where width is the constrained axis and height
 * follows; the row grows to fit whatever the sprite needs.
 *
 * Falls back to the pill if the sprite is missing, so the run always starts.
 */
function StartButton({ onClick }: { onClick: () => void }) {
  const [ok, setOk] = useState(true);
  const ref = useRef<HTMLImageElement>(null);

  // `onError` only catches failures React was mounted for; an image that 404s
  // before hydration finishes never fires it.
  useEffect(() => {
    const el = ref.current;
    if (el && el.complete && el.naturalWidth === 0) setOk(false);
  }, []);

  if (!ok) {
    return (
      <button
        onClick={onClick}
        className="w-full rounded-full bg-splat py-[2.6cqw] text-[4.2cqw] font-black uppercase tracking-wide text-foam shadow-[0_0.9cqw_0_#a3125f] active:translate-y-[0.5cqw] active:shadow-[0_0.4cqw_0_#a3125f]"
      >
        Start fishing
      </button>
    );
  }

  return (
    <button
      onClick={onClick}
      aria-label="Start fishing"
      className="mx-auto block w-[44cqw] origin-bottom transition-transform duration-100 active:scale-[0.94]"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={ref}
        src="/assets/btn_start.webp"
        alt="Start fishing"
        draggable={false}
        className="w-full drop-shadow-[0_3px_6px_rgba(0,0,0,0.45)]"
        onError={() => setOk(false)}
      />
    </button>
  );
}

/**
 * Shown while a tapped start is waiting on the camera and the model.
 *
 * Sized to the button it replaces so the layout does not shift. The ring is a
 * conic gradient masked to its own edge rather than a spinning border, because
 * a border spinner at this size shows its corners.
 */
function StartSpinner() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Getting ready"
      className="grid h-[13.2cqw] w-full place-items-center"
    >
      <span className="motion-spin block h-[7cqw] w-[7cqw] rounded-full [background:conic-gradient(from_0deg,transparent_0turn,#ff2d9b_0.85turn,#ff2d9b_1turn)] [mask:radial-gradient(farthest-side,transparent_calc(100%-0.9cqw),#000_calc(100%-0.85cqw))] [-webkit-mask:radial-gradient(farthest-side,transparent_calc(100%-0.9cqw),#000_calc(100%-0.85cqw))]" />
    </div>
  );
}

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
