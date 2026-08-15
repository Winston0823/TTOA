# Nose Fisher

A proof-of-concept vertical web game for validating **game feel on a real phone**. You steer a fishing line with your nose and pay out rope by opening your mouth.

This is a feel prototype, not a complete game. The pipeline is end-to-end — camera → face landmarks → rope physics → catch loop → snapshot → result — but there is exactly one fish type and one 30-second run.

## Stack

| Concern | Choice |
| --- | --- |
| Framework | Next.js App Router + TypeScript, **client-only** (no API routes, no DB, no auth) |
| Rendering | Canvas2D, single `requestAnimationFrame` loop |
| Face tracking | `@mediapipe/tasks-vision` `FaceLandmarker`, VIDEO mode |
| Audio | Web Audio API oscillators, synthesized at runtime (no asset files) |
| Shell UI | Tailwind (chrome only — everything in the playfield is canvas) |
| Deploy | Vercel, zero config |

## Local development

```bash
npm install
npm run dev
```

Open <http://localhost:3000>.

The camera requires a secure context. `localhost` counts as secure, so desktop dev works out of the box. **To test on a phone over your LAN you need HTTPS** — the simplest route is to deploy a preview to Vercel (below) and open that URL on the device. `next dev` over `http://192.168.x.x` will silently deny `getUserMedia`.

```bash
npm run typecheck   # tsc --noEmit
npm run build       # production build
```

## Deploy to Vercel

Zero configuration — the repo is a stock Next.js app.

**From the dashboard:** go to <https://vercel.com/new>, import this Git repository, and click Deploy. Framework detection picks up Next.js; leave every field at its default.

**From the CLI:**

```bash
npm i -g vercel
vercel          # preview deployment
vercel --prod   # production
```

There are no environment variables and no build settings to change.

## How it plays

- **Nose tip (landmark 1)** anchors the top of the rope. Horizontal movement steers; vertical movement is amplified through a non-linear curve so a small head tilt produces large hook travel.
- **Mouth aperture** (inner lip landmarks 13/14, normalized by face height) is read as a **continuous 0–1 value**, never a binary threshold — thresholds flicker at the boundary. Opening pays rope out and the hook sinks; closing retracts it.
- A fish that notices the hook approaches, **pauses**, then performs a wind-up twitch synchronized to **three rising audio ticks**. The catch window opens after the third tick and lasts ~300 ms. It is deliberately forgiving — the ticks exist so the bite can be *anticipated*, and the player is never judged against a timing chart.
- On a catch the fish fights for ~2 s, applying force to the hook. The player counter-steers with their nose. The **snapshot is captured at the moment of maximum nose deflection during that struggle**, not on a timer.

### Teaching mouth-open without a tutorial

Three escalating affordances, in order:

1. The hook **glows and pulses downward** whenever a fish sits below current reach.
2. Opening the mouth **visibly spools rope out**, with a matching sound.
3. Only if the player still hasn't opened their mouth after 5 seconds does a text hint appear.

## Rope feel

The rope is a Verlet chain of ~12 segments anchored at the nose with a weighted hook at the end, solved with **3 constraint iterations per frame**. Low iteration count is deliberate: more iterations converge toward a rigid rod and kill the whip.

The anchor is moved directly each frame while every other node integrates from its own previous position, so momentum propagates down the chain over several frames. **That lag is the swing, and it is intentional.** Quick head movements whip the hook; slow movements drag it. Damping is tuned so a sharp movement settles in roughly one second — responsive and readable, never rigid, never floppy.

Aiming should require a small amount of anticipation and counter-steering. If it ever feels like point-and-click, `ropeSwingDamping` has been raised too far.

### One force system

Currents, fish struggle, and any future hazard all route through `Rope.applyForce` / `Rope.applyMidChainForce`. Nothing bypasses it. Currents are applied on a bell curve peaking at the chain's midpoint, which is what makes the rope visibly bow and pull the hook off-target.

## Tuning

Every value that affects feel is exported from **`lib/config.ts`** — EMA smoothing, the Y amplification curve, rope segment count and stiffness, `swingDamping`, `currentStrength`, mouth aperture sensitivity, catch window duration, fish speed, spawn rate, run duration. Nothing outside that file should hard-code a number that changes how the game feels.

Start here when tuning:

| Symptom | Knob |
| --- | --- |
| Hook can't reach the bottom | `rope.segmentLengthMax`, `anchorYRange` |
| Aiming feels twitchy | `noseEma` (lower = smoother) |
| Rope feels like a rod | `rope.swingDamping` (lower), `rope.solverIterations` (lower) |
| Rope feels like spaghetti | `rope.swingDamping` (raise toward 0.98) |
| Mouth flickers open/closed | `mouth.rawClosed` / `mouth.rawOpen` band |
| Bites too hard to land | `fish.catchWindow`, `fish.catchRadius` |

## Hardening

- **Touch-drag fallback.** If camera permission is denied or unavailable, the game is fully playable by dragging. Horizontal drag steers; dragging past 55% of the screen height pays out rope.
- **MediaPipe is dynamically imported behind `ssr: false`.** It touches `window` at module scope; without this the Next build crashes.
- **The WASM bundle is preloaded during the title screen** with a visible loading state — never on first play.
- **`playsInline` and `muted` on the video element.** iOS Safari forces fullscreen playback otherwise.
- **`audioContext.resume()` runs inside the start tap.** Required for iOS; the context stays muted otherwise.
- **Safe-area insets** are respected via `env(safe-area-inset-*)` and `viewportFit: "cover"`.
- **Portrait lock via CSS**, with a rotate-back overlay in landscape.

## Assets

Fish (3 colour variants) and the hook were generated with Higgsfield from a single shared style descriptor and live in `public/assets` as WebP. Every sprite has a **procedural Canvas2D fallback** in `lib/render.ts` that draws in the same style, so a failed image load degrades rather than breaking.

All VFX — pulse rings, rope, tension, catch flash, water surface, caustics — are drawn procedurally. None of them are sprites.

## Known limits of this POC

- One fish type, one run length, no difficulty curve.
- MediaPipe WASM and the landmark model load from CDN (jsDelivr / Google Storage). Offline play falls back to touch mode.
- The snapshot uses `toDataURL`, so a cross-origin video source would taint the canvas. Same-origin camera capture is fine.
- Verified in headless Chromium end-to-end (title → play → result, touch path). **The face-tracking path needs a pass on a real iOS device.**

## Layout notes

The playfield is a fixed 9:16 stage that scales to fit the viewport. Water occupies the bottom 50%, drawn as a translucent layer at 0.75 alpha over the mirrored camera feed. The waterline is an animated sine curve with reactive bumps when a fish passes or a catch lands. **Fish render under the water layer (softened); rope and hook render over it (crisp).** The catch counter is pips, not a score — there is no numeric score anywhere in the game.
