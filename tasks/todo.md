# Motion design pass — Fisherman's Nose

## Principle
Camera effect, not an app. No slides that imply a page stack; screens are cleared
and composited like ink and prints. Everything new is transform/opacity only —
`stampFly` animating layout props is grandfathered, not a pattern.

## Pass A — event channel (lib/game.ts, lib/config.ts)
- [x] `GamePulse` discrete UI events + `onPulse` callback, mirroring `onState`
- [x] Emit `score` pulses at the two scoring sites (throw-catch, gulp) with
      NORMALISED position so the DOM never needs canvas dims
- [x] Emit `tick` pulses from the existing wind-up `onTick`
- [x] `CONFIG.motion` — every duration in one place, like every other feel value

## Pass B — keyframes (app/globals.css)
- [x] `popArc` (X) + `popRise` (Y) — split axes to get a parabola out of CSS
- [x] `scorePunch`, `stageKick`, `bitePulse`
- [x] Screen transitions: `screenOut` / `screenIn` on the ink lean angle,
      `ringDraw`, `hudIn`
- [x] `cutPunch` for the how-to panels
- [x] `prefers-reduced-motion` block that neuters the screen-wide motion

## Pass C — wiring (components/GameShell.tsx)
- [x] `useExitLatch` — keeps a screen mounted through its exit
- [x] `useCountUp` — result score counts up rather than arriving finished
- [x] `ScorePops` — arc from the catch site to the HUD score; score absorbs it
- [x] Screen kick on catch (one transform on `.stage-inner`)
- [x] Bite anticipation on ticks 1-3
- [x] Title exit sequenced BEFORE `startRun()` so the clock starts with the HUD
- [x] HUD entrance (ring draws, score punches up)
- [x] Result entrance staggered; result exit before `backToTitle()`
- [x] Carousel overshoot + neighbour lag
- [x] How-to cut punch

## Verify
- [x] `tsc --noEmit`, `npm run build`
- [x] Live: transitions, a real catch, reduced-motion

## Review

Shipped all six juice items plus the three screen transitions.

**What changed structurally.** The game gained a second output channel: `onPulse`
alongside `onState`. A per-frame snapshot can say what the total IS but not that
something HAPPENED or where — and diffing snapshots would have missed a gulp
that swaps a reeled value for an equal one, and could never place the number on
the stage. Positions are normalised 0..1 so the DOM layer never learns the
canvas dimensions.

**The ordering fix that mattered most.** `handleStart` now clears the title
BEFORE calling `startRun()`. Previously the phase flipped instantly, so with any
exit animation the clock would have been running behind a screen the player
could still see. It also parallelises the exit with `initCamera`, which is the
slowest thing on that path — the hitch becomes time the animation was spending
anyway.

**Two retrigger traps, both real.** A CSS animation does not replay because its
class is still applied, so the stage kick and the score punch are keyed and
replay per catch. The how-to punch could NOT use that trick: those seven images
stay mounted specifically so the browser decodes them once, and a changing key
would remount and re-decode the panel being looked at — so that one retriggers
by moving the class between elements instead.

**Verified.** `tsc --noEmit`, `npm run build`, transition class sequencing
across title -> playing -> result, arc curvature sampled live (bows ~12cqw off
the straight line), reduced-motion block parsed with the right selectors, all 12
keyframes resolve.

**Not verified live:** the score pop and stage kick firing from a REAL catch, and
the count-up on a non-zero total. No catch happened in any headless run — there
was no face in frame, so every run scored 0. The arc CSS was proven with an
injected replica and the easing ramp in isolation; the wiring between them is
typechecked but unexercised. Worth one manual run.

## Next
- Score pop currently flies to a hard-coded target (`POP_TARGET_X/Y`) rather than
  a measured one, deliberately: a getBoundingClientRect per catch is a forced
  layout in the one moment that has to hold 60fps. If the HUD moves, that
  constant moves with it.
- The result screen's pieces share one entrance. Staggering header / carousel /
  CTA individually is the obvious next increment.

## Fixes after first play (2026-08-18)
- [x] **Catch blacked out the whole stage.** Keying `.stage-inner` for the kick
      remounted the canvas and video out from under the engine. Kick now runs
      through `element.animate()`; canvas/video identity verified stable across it.
- [x] **Score pops flew from the top-left corner.** The keyframe's `transform`
      replaced the inline `transform` doing the positioning. Position moved to
      `left`/`top`; verified a pop launches at (33.9, 72.8) from a fish at
      (32, 72) and lands at (88.7, 15.6) against a counter at (90.7, 14.9).
- [x] `.ink-hud-damage` — damage colour without the sting animation, so a losing
      pop does not have its centring transform overwritten.

## Camera start-up (2026-08-19)
Diagnosis: the Start button was gated on `preload()`, i.e. on ~6.4MB from two
third-party CDNs (2.65MB brotli WASM from jsdelivr, 3.76MB UNCOMPRESSED model
from googleapis, the latter cached only `max-age=3600`). "Camera slow to get
ready" was really "model slow to arrive", followed by a second serial wait for
`getUserMedia`. Self-hosting was considered and rejected as not worth the ops
burden for a prototype.

- [x] **Start is never gated on the face model.** `initCamera` no longer bails
      when the tracker is missing — it acquires the camera either way and picks
      the input mode at the end from whatever has actually landed. Its return
      value now means one thing: did we get a camera.
- [x] **The run waits for the camera's FIRST FRAME**, not just `play()`.
      `waitForFirstFrame` polls `readyState >= 2 && videoWidth > 0` on rAF,
      bounded by `CONFIG.camera.firstFrameTimeout` (2500ms).
- [x] **`starting` state machine** with a "Waking the camera…" indicator for the
      gap between the 300ms exit finishing and the camera producing frames.
- [x] Input mode is re-decided on every run, so a first take that was drag-only
      upgrades itself on the next one with no player action.

### Verified live
| path | result |
| --- | --- |
| model not loaded | Start button present immediately |
| camera takes 1.5s | indicator at 409ms, run starts at 1842ms with clock at **30s** |
| camera fast | indicator never flashes, starts immediately |
| camera denied | starts after 416ms (exit only), no hang, touch mode |

Not observed live: the "Still loading face tracking" note, because the model is
HTTP-cached in this browser and `loading` was already `ready`. It is a one-line
ternary beside the `failed` branch.

### Deliberately NOT done
No mid-run hot-swap to face control if the model lands during a take — it would
yank the hook to the player's nose out from under an active drag. The run they
started is the run they finish.

## Start gating, take 2 (2026-08-20)
Take 1 let the run begin on drag control and upgrade to face control mid-run.
Rejected in review: a 30-second take that starts before its controls work is
worse than one that starts a second later. Replaced with: tap is always
available, but it WAITS behind a spinner until everything is ready.

- [x] **Root cause of "the rope takes a while to track".** `preload()` assigned
      `this.tracker` BEFORE awaiting `load()`, so the tracker was truthy for the
      entire multi-second download. `initCamera` picked face mode from that
      truthiness, `detect()` returned its centred `ok:false` sample because the
      landmarker was still null, and the rope sat frozen mid-screen with the
      clock running. `FaceTracker.ready` existed the whole time and nothing read
      it. Tracker is now assigned only after `load()` resolves, and
      `canTrackFace` checks `ready`.
- [x] Start tap waits on camera AND model, both awaited together so they
      overlap. `initCamera` is called first and unawaited so `getUserMedia`
      stays inside the gesture for iOS.
- [x] Input mode decided in `startRun`, not `initCamera` — it must read the
      model's state at the last possible moment.
- [x] `FaceTracker.warmUp()` — the GPU delegate compiles shaders on first use.
      **Measured in-browser: first `detectForVideo` 175ms vs ~11ms median.**
      Now spent behind the spinner instead of in frame one of the run.
- [x] Spinner replaces the button in place, same height, so the how-to art does
      not resize mid-tap.
- [x] Reverted from take 1: mid-run handover, `CONFIG.camera.handoverTime`, the
      "still loading" in-game hint.

### Verified live
| path | result |
| --- | --- |
| model still loading (600s test delay) | button swaps to spinner, title held, run does NOT start, note reads "Getting face tracking ready…" |
| normal | no spinner, run starts in 429ms, clock 30s, video delivering 640x480 |
| camera denied (earlier) | no hang, touch mode |

### Testing note
Early runs of this test were INVALID: my own tool round-trip left the page idle
for ~30s between navigate and click, so the model always finished loading before
the tap. Console timestamps showed preload finishing at 28s while the click
happened at 34s. Any future test of a loading state needs an artificial delay
longer than the harness round-trip, not just a cache-bust.
