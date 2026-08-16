import { CONFIG } from "./config";
import { GameAudio } from "./audio";
import {
  FaceTracker,
  landmarkToCanvas,
  normalizeMouth,
  type FaceSample,
} from "./face";
import {
  isCatchable,
  isFishGone,
  spawnFish,
  updateFish,
  type Fish,
  type Rarity,
} from "./fish";
import { Rope, currentForce } from "./rope";
import {
  drawCamera,
  drawCaustics,
  drawFish,
  drawPulseRing,
  drawRope,
  drawTension,
  drawWaterLayer,
  waterlineY,
  type WaterBump,
} from "./render";

export type Phase = "title" | "playing" | "result";
export type InputMode = "face" | "touch";

/** What earned a frame a place on the roll. */
export type CaptureKind = "catch" | "gulp" | "mouth" | "tug";

export interface Capture {
  id: number;
  kind: CaptureKind;
  /** JPEG data URL of the camera frame composited with the game overlay. */
  src: string;
  /** Comedy score at the moment it was shot. Decides what survives the cap. */
  score: number;
}

/**
 * One landed fish, in the order it was thrown. The HUD list needs per-catch
 * rarity, which the `caught` / `caughtRare` totals cannot reconstruct.
 */
export interface CatchEntry {
  id: number;
  rarity: Rarity;
  /** True once this specific fish was also caught in the mouth on the way down. */
  gulped: boolean;
}

export interface GameSnapshotState {
  phase: Phase;
  timeLeft: number;
  caught: number;
  /** Of those catches, how many were the rare tier. */
  caughtRare: number;
  /** Every catch this run, oldest first. Drives the on-screen caught list. */
  catches: CatchEntry[];
  /** True once the player has opened their mouth at least once. */
  usedMouth: boolean;
  showMouthHint: boolean;
  /** Bonus points from catching thrown fish in the mouth. */
  gulps: number;
  /** The player's face has dropped below the waterline — nothing can be landed. */
  submerged: boolean;
  inputMode: InputMode;
  captures: Capture[];
}

interface Flash {
  x: number;
  y: number;
  t: number;
  /** Per-flash shape seed, so no two ink splats are identical. */
  seed: number;
}

const SPRITE_FILES = {
  common: "/assets/fish_common.webp",
  rare: "/assets/fish_rare.webp",
} as const;

export class Game {
  private ctx: CanvasRenderingContext2D;
  private w = CONFIG.canvas.width;
  private h = CONFIG.canvas.height;

  private rope: Rope;
  private fishes: Fish[] = [];
  private bumps: WaterBump[] = [];
  private flashes: Flash[] = [];

  private audio = new GameAudio();
  private tracker: FaceTracker | null = null;
  private video: HTMLVideoElement | null = null;

  private raf = 0;
  private lastTs = 0;
  private elapsed = 0;
  private spawnTimer = 0;

  private phase: Phase = "title";
  private caught = 0;
  private caughtRare = 0;
  private catches: CatchEntry[] = [];
  private timeLeft: number = CONFIG.runDuration;
  private usedMouth = false;
  private noMouthTime = 0;

  private hookedFish: Fish | null = null;
  private struggleTime = 0;
  /** Fish caught in the mouth on the way down. */
  private gulps = 0;
  /**
   * True while the anchor (the nose) is below the waterline. Because the rope
   * hangs off the face, a player sitting too low in frame can never bring a
   * hook to the surface, so the game becomes quietly unwinnable. We detect it
   * and say so rather than letting them wonder why nothing lands.
   */
  private submerged = false;

  // ---- photo roll --------------------------------------------------------
  private captures: Capture[] = [];
  private nextCaptureId = 1;
  private lastShotAt = -Infinity;

  private inputMode: InputMode = "face";
  private touch: { x: number; y: number } | null = null;
  private lastSample: FaceSample = {
    noseX: 0.5,
    noseY: 0.46,
    mouthX: 0.5,
    mouthY: 0.52,
    mouth: 0,
    ok: false,
  };

  private sprites: { common: HTMLImageElement | null; rare: HTMLImageElement | null } = {
    common: null,
    rare: null,
  };
  private hookSprite: HTMLImageElement | null = null;

  private offscreen: HTMLCanvasElement;

  onState: (s: GameSnapshotState) => void = () => {};

  constructor(private canvas: HTMLCanvasElement) {
    canvas.width = this.w;
    canvas.height = this.h;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas2D unavailable");
    this.ctx = ctx;

    this.offscreen = document.createElement("canvas");
    this.offscreen.width = Math.round(this.w * CONFIG.capture.scale);
    this.offscreen.height = Math.round(this.h * CONFIG.capture.scale);

    this.rope = new Rope(this.w / 2, this.h * CONFIG.anchorYRange[0]);
    this.loadSprites();
  }

  // ------------------------------------------------------------------ setup
  private loadSprites() {
    (Object.keys(SPRITE_FILES) as (keyof typeof SPRITE_FILES)[]).forEach((key) => {
      const img = new Image();
      img.onload = () => {
        this.sprites[key] = img;
      };
      // A missing sprite is not fatal — render.ts falls back to canvas shapes.
      img.onerror = () => {
        this.sprites[key] = null;
      };
      img.src = SPRITE_FILES[key];
    });
    const hook = new Image();
    hook.onload = () => {
      this.hookSprite = hook;
    };
    hook.onerror = () => {
      this.hookSprite = null;
    };
    hook.src = "/assets/hook.webp";
  }

  /** Preloads MediaPipe. Called on the title screen, never on first play. */
  async preload(): Promise<{ ok: boolean; error?: string }> {
    try {
      this.tracker = new FaceTracker();
      await this.tracker.load();
      return { ok: true };
    } catch (e) {
      this.tracker = null;
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Requests the camera. Falls back to touch input if it fails. */
  async initCamera(video: HTMLVideoElement): Promise<boolean> {
    this.video = video;
    if (!this.tracker) {
      this.inputMode = "touch";
      return false;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      this.inputMode = "face";
      return true;
    } catch {
      this.inputMode = "touch";
      this.video = null;
      return false;
    }
  }

  get currentInputMode() {
    return this.inputMode;
  }

  // ------------------------------------------------------------------- run
  async startRun() {
    await this.audio.start();
    this.audio.startBass();

    this.phase = "playing";
    this.caught = 0;
    this.caughtRare = 0;
    this.catches = [];
    this.timeLeft = CONFIG.runDuration;
    this.usedMouth = false;
    this.noMouthTime = 0;
    this.fishes = [];
    this.bumps = [];
    this.flashes = [];
    this.hookedFish = null;
    this.gulps = 0;
    this.captures = [];
    this.lastShotAt = -Infinity;
    this.spawnTimer = 0;
    this.tracker?.reset();
    this.rope = new Rope(this.w / 2, this.h * CONFIG.anchorYRange[0]);
    this.emit();
  }

  private endRun() {
    this.phase = "result";
    this.audio.stopBass();
    this.audio.stopSpool();
    // Deliberately no fallback frame. Every trigger is something the player
    // did, so an empty roll means they did none of them — and the result card's
    // empty state says so, which beats captioning a blank stare.
    this.emit();
  }

  backToTitle() {
    this.phase = "title";
    this.emit();
  }

  start() {
    if (this.raf) return;
    this.lastTs = performance.now();
    const loop = (ts: number) => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (ts - this.lastTs) / 1000);
      this.lastTs = ts;
      this.tick(dt, ts);
    };
    this.raf = requestAnimationFrame(loop);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.audio.stop();
    this.tracker?.close();
    const stream = this.video?.srcObject as MediaStream | null;
    stream?.getTracks().forEach((t) => t.stop());
  }

  // ---------------------------------------------------------------- input
  setTouch(x: number | null, y: number | null) {
    this.touch = x === null || y === null ? null : { x, y };
  }

  /**
   * Resolves the frame's anchor position (in canvas units) and rope payout.
   *
   * In face mode the anchor IS the nose — projected through the same transform
   * that draws the camera, with no gain of any kind, so the line visibly hangs
   * off the player's face. Depth comes from paying out rope, never from
   * secretly moving the anchor somewhere the nose isn't.
   *
   * Touch mode has no face to pin to, so it splits the vertical drag: the upper
   * part steers an anchor near the top of the screen, the lower part pays out.
   */
  private readInput(): { anchorX: number; anchorY: number; payout: number } {
    const [aMin, aMax] = CONFIG.anchorYRange;

    if (this.inputMode === "touch") {
      const t = this.touch;
      const band = (v: number) => this.h * (aMin + (aMax - aMin) * v);
      if (!t) return { anchorX: this.w / 2, anchorY: band(0.3), payout: 0 };
      const splitAt = 0.55;
      return {
        anchorX: t.x * this.w,
        anchorY: band(Math.min(1, t.y / splitAt)),
        payout: Math.max(0, Math.min(1, (t.y - splitAt) / (1 - splitAt))),
      };
    }

    const s = this.lastSample;
    const { screenMargin, noseOffset } = CONFIG.anchor;
    const p = landmarkToCanvas(
      s.noseX,
      s.noseY,
      this.video?.videoWidth ?? 0,
      this.video?.videoHeight ?? 0,
      this.w,
      this.h
    );

    // Clamp so a bad frame or a player leaning out of shot cannot fling the
    // anchor off-canvas and drag the whole rope with it.
    const clamp = (v: number, hi: number) =>
      Math.max(screenMargin, Math.min(hi - screenMargin, v));

    return {
      anchorX: clamp(p.x, this.w),
      anchorY: clamp(p.y + noseOffset, this.h),
      payout: normalizeMouth(s.mouth),
    };
  }

  // ----------------------------------------------------------------- tick
  private tick(dt: number, ts: number) {
    this.elapsed += dt;

    if (this.inputMode === "face" && this.tracker && this.video) {
      this.lastSample = this.tracker.detect(this.video, ts);
    }

    const { anchorX, anchorY, payout } = this.readInput();

    const waterTop = this.h * (1 - CONFIG.water.coverage);

    // Measured against the live, wavy surface rather than the flat baseline, so
    // it agrees with what the player can see lapping at their chin.
    this.submerged =
      anchorY > waterlineY(anchorX, waterTop, this.elapsed, this.bumps);

    if (this.phase === "playing") {
      this.updatePlay(dt, payout, anchorX, anchorY, waterTop);
    } else {
      // Idle rope on the title/result screens keeps the scene alive.
      this.rope.updatePayout(payout * 0.35, dt);
      this.rope.step(dt, anchorX, anchorY, waterTop);
    }

    this.draw(waterTop, payout);
  }

  private updatePlay(
    dt: number,
    payout: number,
    anchorX: number,
    anchorY: number,
    waterTop: number
  ) {
    // ---- timer ----------------------------------------------------------
    this.timeLeft -= dt;
    if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      this.endRun();
      return;
    }

    // ---- mouth teaching --------------------------------------------------
    if (payout > CONFIG.mouth.activeAt) {
      this.usedMouth = true;
    } else if (!this.usedMouth) {
      this.noMouthTime += dt;
    }

    // ---- rope ------------------------------------------------------------
    this.rope.updatePayout(payout, dt);

    // Everything that pushes the rope goes through the one force system.
    const cf = currentForce(this.elapsed);
    this.rope.applyMidChainForce(cf, 0);
    this.rope.applyForce(
      this.rope.hookIndex,
      cf * CONFIG.forces.currentHookShare,
      0
    );

    if (this.hookedFish) {
      // A struggling fish is just another force at the hook end: a steady
      // downward weight the player has to out-pull, plus a thrash that makes
      // the haul a fight rather than a straight lift.
      const f = CONFIG.forces;
      const rare = this.hookedFish.rarity === "rare";
      const scale = rare ? CONFIG.fish.rareStruggleScale : 1;
      const phase = this.struggleTime * Math.PI * 2 * f.struggleFrequency;
      const ramp = Math.min(1, this.struggleTime / CONFIG.fish.fightRampIn);
      // A rare fish fights noticeably harder — that is what makes it feel rare.
      const power = f.struggleStrength * scale;
      this.rope.applyForce(
        this.rope.hookIndex,
        Math.sin(phase) * power * ramp,
        (CONFIG.fish.fishWeight * scale +
          Math.abs(Math.cos(phase * 0.7)) * power * 0.45) *
          ramp
      );
    }

    this.rope.step(dt, anchorX, anchorY, waterTop);

    // ---- spooling sound --------------------------------------------------
    const spooling = Math.max(0, payout - this.rope.payout) * 3;
    this.audio.setSpool(this.rope.payout > 0.05 ? spooling : 0);

    // ---- fish ------------------------------------------------------------
    this.spawnTimer += dt;
    if (
      this.spawnTimer >= CONFIG.fish.spawnInterval &&
      this.fishes.length < CONFIG.fish.maxAlive
    ) {
      this.spawnTimer = 0;
      this.fishes.push(spawnFish(this.w, waterTop, this.h));
    }

    const hook = this.rope.hook;
    for (const f of this.fishes) {
      updateFish(f, dt, this.elapsed, hook.x, hook.y, this.w, waterTop, {
        onTick: (n) => this.audio.tick(n),
        onMiss: () => {
          // Missing is cheap and quiet. The player is never scored on timing.
          this.audio.thunk();
        },
        onSurfacePass: (x) => this.addBump(x, 0.35),
      });

      // Catch check — generous radius, generous window.
      if (!this.hookedFish && isCatchable(f, hook.x, hook.y)) {
        this.hookFish(f, hook.x, hook.y);
      }
    }
    this.fishes = this.fishes.filter((f) => !isFishGone(f, this.w, this.h));

    // ---- the fight -------------------------------------------------------
    // A fish is earned by hauling it to the surface and throwing it clear, not
    // by waiting out a timer.
    let landed = false;
    if (this.hookedFish) {
      this.struggleTime += dt;
      const surface = waterlineY(hook.x, waterTop, this.elapsed, this.bumps);
      landed = this.tryFling(dt, surface, payout);
      if (!landed && this.struggleTime >= CONFIG.fish.escapeAfter) {
        this.loseFish();
      }
    }

    // ---- the gulp --------------------------------------------------------
    // Before the photo pass, so a gulped frame is banked by tryGulp itself and
    // the scorer never spends this frame's slot on something lesser.
    this.tryGulp(payout, dt);

    // ---- photo roll ------------------------------------------------------
    this.trackCaptures(dt, payout, landed);

    // ---- transient VFX ---------------------------------------------------
    for (const b of this.bumps) b.age += dt;
    this.bumps = this.bumps.filter((b) => b.age < CONFIG.water.bumpDecay);
    for (const fl of this.flashes) fl.t += dt * 1.6;
    this.flashes = this.flashes.filter((f) => f.t < 1);

    this.emit();
  }

  private hookFish(f: Fish, hx: number, hy: number) {
    f.state = "hooked";
    f.stateTime = 0;
    this.hookedFish = f;
    this.struggleTime = 0;
    this.flashes.push({ x: hx, y: hy, t: 0, seed: f.id * 0.618 });
    this.audio.catchSting();
    this.addBump(hx, 0.5);
  }

  /**
   * The catch. Haul the fish up to the surface, then snap your head upward to
   * throw it clear of the water.
   *
   * The test is on the ANCHOR's velocity — the player's actual head movement —
   * not the hook's. The hook is the wrong signal twice over: reeling the line
   * in yanks it upward faster than any head-flick does, and a thrashing fish
   * whips it around on its own. Both would fire this without the player having
   * expressed anything. The nose only moves because the player moved it.
   * @returns true if the fish was thrown this frame.
   */
  private tryFling(dt: number, surface: number, payout: number): boolean {
    const f = this.hookedFish;
    if (!f) return false;

    const FL = CONFIG.fling;
    const hook = this.rope.hook;

    // You cannot throw a fish you have not hauled up yet.
    if (hook.y > surface + FL.depthAllowance) return false;
    if (!this.isFlingMotion(dt)) return false;

    const { vx, vy } = this.rope.anchorVelocity(dt);

    f.state = "flung";
    f.stateTime = 0;
    // The throw carries the player's own momentum, so a harder flick sends the
    // fish higher — but only up to the ceiling, past which it would leave the
    // screen entirely and never fall back in time to be caught.
    f.vx = Math.max(-FL.maxLaunchSide, Math.min(FL.maxLaunchSide, vx * FL.transfer));
    f.vy = Math.max(-FL.maxLaunchUp, vy * FL.transfer - FL.kick);
    f.spin = 0;
    f.x = hook.x;
    f.y = hook.y;

    this.caught += 1;
    if (f.rarity === "rare") this.caughtRare += 1;
    // Keyed by fish id so a later gulp can find this exact entry and flag it.
    this.catches.push({ id: f.id, rarity: f.rarity, gulped: false });
    this.hookedFish = null;
    this.flashes.push({ x: hook.x, y: hook.y, t: 0, seed: f.id * 0.618 });
    this.addBump(hook.x, 1);
    this.audio.catchSting();
    // Scored like everything else, but with `catchBonus` on top. A catch frame
    // is mid-throw by definition — upward velocity is what triggered it.
    this.addCapture("catch", this.funnyScore(dt, payout, "catch").total);
    return true;
  }

  /** The upward head-snap gesture, independent of whether a fish is on. */
  private isFlingMotion(dt: number): boolean {
    const FL = CONFIG.fling;
    const { vx, vy } = this.rope.anchorVelocity(dt);
    const up = -vy;
    // Reject head-shakes and sideways lunges — this is an upward throw.
    return up >= FL.speed && up >= Math.abs(vx) * FL.coneRatio;
  }

  /** The player took too long — the fish throws the hook and bolts. */
  private loseFish() {
    const f = this.hookedFish;
    if (!f) return;
    f.state = "flee";
    f.stateTime = 0;
    this.hookedFish = null;
    this.addBump(this.rope.hook.x, 0.6);
    this.audio.thunk();
  }

  /**
   * Where the player's mouth is, in canvas units.
   * Touch mode has no face, so it falls back to the anchor — the drag point is
   * the only thing standing in for the player's position there.
   */
  private mouthPoint(): { x: number; y: number } {
    if (this.inputMode === "touch") {
      const a = this.rope.anchor;
      return { x: a.x, y: a.y };
    }
    const s = this.lastSample;
    return landmarkToCanvas(
      s.mouthX,
      s.mouthY,
      this.video?.videoWidth ?? 0,
      this.video?.videoHeight ?? 0,
      this.w,
      this.h
    );
  }

  /**
   * Catch a thrown fish on the way down, in your mouth.
   *
   * Only descending fish qualify: without that the fish is swallowed a pixel
   * after it leaves the hook, while still travelling upward past the face, and
   * the arc that makes the trick readable never happens.
   */
  private tryGulp(payout: number, dt: number) {
    const G = CONFIG.fling.gulp;
    if (payout < G.aperture) return;

    const m = this.mouthPoint();
    for (const f of this.fishes) {
      if (f.state !== "flung" || f.fade <= 0) continue;
      if (f.vy < G.minFallSpeed) continue;
      if (Math.hypot(f.x - m.x, f.y - m.y) > G.radius) continue;

      // Gone — eaten, not landed. Culled next frame by `isFishGone`.
      f.fade = 0;
      this.gulps += G.points;
      // Upgrade the entry this fish already earned when it was thrown, rather
      // than adding a second one — a gulp is a better finish to one catch, not
      // an extra fish.
      const entry = this.catches.find((c) => c.id === f.id);
      if (entry) entry.gulped = true;
      this.flashes.push({ x: m.x, y: m.y, t: 0, seed: f.id * 0.618 });
      this.audio.catchSting();
      this.addCapture("gulp", this.funnyScore(dt, payout, "gulp").total);
      return;
    }
  }

  /**
   * Scores the current frame for comedy and banks it only if it clears the bar.
   *
   * Event triggers were the wrong model: firing on "mouth is open" or "head
   * moved fast" shot every such moment equally, so a run filled with
   * near-identical portraits of a face above a paid-out line and the genuinely
   * absurd frames drowned in them. What the good ones have in common is the
   * hook right beside the face WHILE something else is going on.
   */
  private trackCaptures(dt: number, payout: number, landedThisFrame: boolean) {
    const C = CONFIG.capture;
    // A landed fish already banked this exact frame as its catch photo.
    if (landedThisFrame) return;
    if (this.elapsed - this.lastShotAt < C.minGap) return;

    const s = this.funnyScore(dt, payout);
    // The hook has to be up by the face before anything else earns a frame.
    if (s.hookNear < C.minHookNear) return;
    if (s.total < C.minScore) return;

    this.lastShotAt = this.elapsed;
    // Label by whichever ingredient dominated — caption only, no logic rides on it.
    this.addCapture(s.tug > s.mouth ? "tug" : "mouth", s.total);
  }

  /** Breaks the current frame into its comedy ingredients. */
  private funnyScore(dt: number, payout: number, kind?: CaptureKind) {
    const C = CONFIG.capture;
    const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

    const { vx, vy } = this.rope.anchorVelocity(dt);
    const anchor = this.rope.anchor;
    const hook = this.rope.hook;
    const dist = Math.hypot(hook.x - anchor.x, hook.y - anchor.y);

    const mouth = clamp01(payout);
    const hookNear = clamp01(1 - dist / C.hookNearRadius);
    const tug = clamp01(Math.hypot(vx, vy) / C.tugSpeed);
    // Upward motion only, so a throw outranks an equally fast head-shake.
    const throwUp = clamp01(-vy / C.tugSpeed);

    const bonus =
      kind === "catch" ? C.catchBonus : kind === "gulp" ? C.gulpBonus : 0;

    return {
      mouth,
      hookNear,
      tug,
      throwUp,
      total:
        mouth * C.weight.mouth +
        hookNear * C.weight.hookNear +
        tug * C.weight.tug +
        throwUp * C.weight.throwUp +
        bonus,
    };
  }

  /** Composites the current frame onto the roll. */
  private addCapture(kind: CaptureKind, score = 0) {
    const src = this.composite();
    if (!src) return;

    let next = this.captures.concat({
      id: this.nextCaptureId++,
      kind,
      src,
      score,
    });

    if (next.length > CONFIG.capture.maxShots) {
      // Strict top-N by score: evict the weakest frame, whatever it is. With
      // only four slots there is no room for an exemption — a catch holds its
      // place on `catchBonus`, big enough to beat any ordinary frame but still
      // losing to a better catch.
      let victim = 0;
      for (let i = 1; i < next.length; i++) {
        if (next[i].score < next[victim].score) victim = i;
      }
      next = next.slice(0, victim).concat(next.slice(victim + 1));
    }

    this.captures = next;
  }

  private addBump(x: number, strength: number) {
    // Avoid stacking dozens of near-identical bumps at the same spot.
    const recent = this.bumps.find((b) => Math.abs(b.x - x) < 40 && b.age < 0.12);
    if (recent) return;
    this.bumps.push({ x, strength, age: 0 });
    if (this.bumps.length > 12) this.bumps.shift();
  }

  /** Mirrored video frame + the canvas overlay, flattened to a data URL. */
  private composite(): string | null {
    try {
      const octx = this.offscreen.getContext("2d");
      if (!octx) return null;
      const ow = this.offscreen.width;
      const oh = this.offscreen.height;
      octx.clearRect(0, 0, ow, oh);
      // drawCamera derives its own cover-fit from the size it is handed, so the
      // downscale needs no special casing here.
      drawCamera(octx, this.video, ow, oh);
      octx.drawImage(this.canvas, 0, 0, ow, oh);
      return this.offscreen.toDataURL("image/jpeg", CONFIG.capture.quality);
    } catch {
      // Tainted canvas or an unsupported format — the result card copes.
      return null;
    }
  }

  // ----------------------------------------------------------------- draw
  private draw(waterTop: number, payout: number) {
    const ctx = this.ctx;
    const hook = this.rope.hook;

    drawCamera(ctx, this.video, this.w, this.h);

    // Fish below the surface are drawn BEFORE the water layer so the layer
    // tints and softens them. Fish above it are drawn after, crisp.
    const submerged: Fish[] = [];
    const above: Fish[] = [];
    for (const f of this.fishes) {
      const surface = waterlineY(f.x, waterTop, this.elapsed, this.bumps);
      (f.y > surface ? submerged : above).push(f);
    }

    ctx.save();
    // Depth separation comes from the translucent water layer drawn on top,
    // NOT from a canvas blur filter. `ctx.filter = blur(...)` costs more than
    // everything else in the frame combined on mobile Safari — it took this
    // scene from 60fps to single digits. Alpha is the cheap equivalent.
    ctx.globalAlpha = CONFIG.water.underwaterAlpha;
    for (const f of submerged) drawFish(ctx, f, this.sprites, this.elapsed);
    ctx.restore();

    drawWaterLayer(ctx, this.w, this.h, waterTop, this.elapsed, this.bumps);
    drawCaustics(ctx, this.w, this.h, waterTop, this.elapsed);

    // Second pass over the submerged fish, on top of the water. Pulls their
    // colour back out of the wash without losing the sense of depth.
    ctx.save();
    ctx.globalAlpha = CONFIG.water.fishRestoreAlpha;
    for (const f of submerged) drawFish(ctx, f, this.sprites, this.elapsed);
    ctx.restore();

    for (const f of above) drawFish(ctx, f, this.sprites, this.elapsed);

    // Glow when a fish sits below the hook's current reach — the wordless
    // instruction to open your mouth.
    const glow = this.computeReachGlow(hook.y, payout);
    drawTension(ctx, this.rope, this.hookedFish ? 1 : 0);
    drawRope(ctx, this.rope, this.hookSprite, glow, this.elapsed);

    for (const fl of this.flashes) drawPulseRing(ctx, fl.x, fl.y, fl.t, fl.seed);
  }

  /** 0..1 — how strongly to hint "go deeper". */
  private computeReachGlow(hookY: number, payout: number): number {
    if (this.phase !== "playing") return 0;
    if (payout > 0.35) return 0;
    const below = this.fishes.filter(
      (f) => f.state !== "flung" && f.y > hookY + 120
    );
    if (below.length === 0) return 0;
    return Math.min(1, 0.5 + below.length * 0.25);
  }

  // ---------------------------------------------------------------- state
  private emit() {
    this.onState({
      phase: this.phase,
      timeLeft: this.timeLeft,
      caught: this.caught,
      caughtRare: this.caughtRare,
      // Copied so React sees a new array identity each emit.
      catches: this.catches.map((c) => ({ ...c })),
      usedMouth: this.usedMouth,
      showMouthHint:
        this.phase === "playing" &&
        !this.usedMouth &&
        !this.submerged &&
        this.noMouthTime > CONFIG.mouthHintDelay,
      gulps: this.gulps,
      submerged: this.phase === "playing" && this.submerged,
      inputMode: this.inputMode,
      captures: this.captures,
    });
  }
}
