import { CONFIG } from "./config";
import { GameAudio } from "./audio";
import {
  FaceTracker,
  amplifyNoseX,
  amplifyNoseY,
  normalizeMouth,
  type FaceSample,
} from "./face";
import {
  isCatchable,
  isFishGone,
  spawnFish,
  updateFish,
  type Fish,
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

export interface GameSnapshotState {
  phase: Phase;
  timeLeft: number;
  caught: number;
  /** True once the player has opened their mouth at least once. */
  usedMouth: boolean;
  showMouthHint: boolean;
  inputMode: InputMode;
  snapshot: string | null;
}

interface Flash {
  x: number;
  y: number;
  t: number;
}

const SPRITE_FILES = [
  "/assets/fish_a.webp",
  "/assets/fish_b.webp",
  "/assets/fish_c.webp",
];

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
  private timeLeft: number = CONFIG.runDuration;
  private usedMouth = false;
  private noMouthTime = 0;

  private hookedFish: Fish | null = null;
  private struggleTime = 0;
  /** Nose X at the moment the struggle began — the deflection baseline. */
  private struggleBaseX = 0.5;
  private maxDeflection = 0;
  private lastCaptureAt = -1;
  private snapshot: string | null = null;

  private inputMode: InputMode = "face";
  private touch: { x: number; y: number } | null = null;
  private lastSample: FaceSample = { noseX: 0.5, noseY: 0.46, mouth: 0, ok: false };

  private sprites: (HTMLImageElement | null)[] = [null, null, null];
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
    this.offscreen.width = this.w;
    this.offscreen.height = this.h;

    this.rope = new Rope(this.w / 2, this.h * CONFIG.anchorYRange[0]);
    this.loadSprites();
  }

  // ------------------------------------------------------------------ setup
  private loadSprites() {
    SPRITE_FILES.forEach((src, i) => {
      const img = new Image();
      img.onload = () => {
        this.sprites[i] = img;
      };
      // A missing sprite is not fatal — render.ts falls back to canvas shapes.
      img.onerror = () => {
        this.sprites[i] = null;
      };
      img.src = src;
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
    this.timeLeft = CONFIG.runDuration;
    this.usedMouth = false;
    this.noMouthTime = 0;
    this.fishes = [];
    this.bumps = [];
    this.flashes = [];
    this.hookedFish = null;
    this.snapshot = null;
    this.maxDeflection = 0;
    this.lastCaptureAt = -1;
    this.spawnTimer = 0;
    this.tracker?.reset();
    this.rope = new Rope(this.w / 2, this.h * CONFIG.anchorYRange[0]);
    this.emit();
  }

  private endRun() {
    this.phase = "result";
    this.audio.stopBass();
    this.audio.stopSpool();
    // If the player never entered a struggle, fall back to a final frame so the
    // result card always has an image.
    if (!this.snapshot) this.snapshot = this.composite();
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
   * Resolves the frame's control values from whichever input is active.
   * Touch mode splits the vertical drag: the upper part steers the anchor,
   * the lower part pays out rope — so it is fully playable without a camera.
   */
  private readInput(): { anchorT: number; xT: number; payout: number } {
    if (this.inputMode === "touch") {
      const t = this.touch;
      if (!t) return { anchorT: 0.3, xT: 0.5, payout: 0 };
      const splitAt = 0.55;
      const anchorT = Math.min(1, t.y / splitAt);
      const payout = Math.max(0, Math.min(1, (t.y - splitAt) / (1 - splitAt)));
      return { anchorT, xT: t.x, payout };
    }

    const s = this.lastSample;
    return {
      anchorT: amplifyNoseY(s.noseY),
      xT: amplifyNoseX(s.noseX),
      payout: normalizeMouth(s.mouth),
    };
  }

  // ----------------------------------------------------------------- tick
  private tick(dt: number, ts: number) {
    this.elapsed += dt;

    if (this.inputMode === "face" && this.tracker && this.video) {
      this.lastSample = this.tracker.detect(this.video, ts);
    }

    const { anchorT, xT, payout } = this.readInput();

    const waterTop = this.h * (1 - CONFIG.water.coverage);
    const [aMin, aMax] = CONFIG.anchorYRange;
    const anchorX = xT * this.w;
    const anchorY = this.h * (aMin + (aMax - aMin) * anchorT);

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
      // A struggling fish is just another force at the hook end.
      const f = CONFIG.forces;
      const phase = this.struggleTime * Math.PI * 2 * f.struggleFrequency;
      const ramp = Math.min(1, this.struggleTime * 3);
      this.rope.applyForce(
        this.rope.hookIndex,
        Math.sin(phase) * f.struggleStrength * ramp,
        Math.abs(Math.cos(phase * 0.7)) * f.struggleStrength * 0.45 * ramp
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
    this.fishes = this.fishes.filter((f) => !isFishGone(f, this.w));

    // ---- struggle + snapshot --------------------------------------------
    if (this.hookedFish) {
      this.struggleTime += dt;
      this.trackDeflection();
      if (this.hookedFish.state === "landed") {
        this.landFish();
      }
    }

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
    this.struggleBaseX = this.lastSample.noseX;
    this.maxDeflection = 0;
    this.lastCaptureAt = -1;
    this.flashes.push({ x: hx, y: hy, t: 0 });
    this.audio.catchSting();
    this.addBump(hx, 0.5);
  }

  private landFish() {
    this.caught += 1;
    this.hookedFish = null;
    this.addBump(this.rope.hook.x, 1);
    this.audio.catchSting();
  }

  /**
   * The snapshot is taken at the moment of maximum nose deflection during a
   * struggle — the peak of the player's counter-steer, not an arbitrary timer.
   */
  private trackDeflection() {
    const cur =
      this.inputMode === "touch"
        ? Math.abs((this.touch?.x ?? 0.5) - 0.5) * 2
        : Math.abs(this.lastSample.noseX - this.struggleBaseX) * 2.4;

    if (cur > this.maxDeflection + 0.02 && cur > 0.12) {
      this.maxDeflection = cur;
      // Throttle: toDataURL is expensive and we only need the peak frame.
      if (this.elapsed - this.lastCaptureAt > 0.15) {
        this.lastCaptureAt = this.elapsed;
        this.snapshot = this.composite();
      }
    }
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
      octx.clearRect(0, 0, this.w, this.h);
      drawCamera(octx, this.video, this.w, this.h);
      octx.drawImage(this.canvas, 0, 0);
      return this.offscreen.toDataURL("image/jpeg", 0.82);
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
    // Softening the underwater fish is what sells the depth separation.
    // The saturate/brightness lift is there to claw back the colour the 0.75
    // water layer would otherwise wash out of them.
    if (typeof ctx.filter === "string") {
      ctx.filter = `blur(${CONFIG.water.underwaterBlur}px) saturate(1.5) brightness(1.14)`;
    }
    for (const f of submerged) drawFish(ctx, f, this.sprites, this.elapsed);
    ctx.restore();

    drawWaterLayer(ctx, this.w, this.h, waterTop, this.elapsed, this.bumps);
    drawCaustics(ctx, this.w, this.h, waterTop, this.elapsed);

    for (const f of above) drawFish(ctx, f, this.sprites, this.elapsed);

    // Glow when a fish sits below the hook's current reach — the wordless
    // instruction to open your mouth.
    const glow = this.computeReachGlow(hook.y, payout);
    drawTension(ctx, this.rope, this.hookedFish ? 1 : 0);
    drawRope(ctx, this.rope, this.hookSprite, glow, this.elapsed);

    for (const fl of this.flashes) drawPulseRing(ctx, fl.x, fl.y, fl.t);
  }

  /** 0..1 — how strongly to hint "go deeper". */
  private computeReachGlow(hookY: number, payout: number): number {
    if (this.phase !== "playing") return 0;
    if (payout > 0.35) return 0;
    const below = this.fishes.filter(
      (f) => f.state !== "landed" && f.y > hookY + 120
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
      usedMouth: this.usedMouth,
      showMouthHint:
        this.phase === "playing" &&
        !this.usedMouth &&
        this.noMouthTime > CONFIG.mouthHintDelay,
      inputMode: this.inputMode,
      snapshot: this.snapshot,
    });
  }
}
