import { CONFIG } from "./config";

export type FishState =
  | "drift"
  | "approach"
  | "pause"
  | "windup"
  | "window"
  | "hooked"
  | "flung"
  | "flee";

/**
 * Which species a fish is. Still called `rarity` on the fish and on catch
 * entries because that is what the field has always meant to the rest of the
 * game — but it now selects a point value, not just a tier.
 */
export type Rarity = "common" | "rare" | "puffer";

export interface Fish {
  id: number;
  x: number;
  y: number;
  /** -1 = swimming left, 1 = swimming right. Sprite art faces left. */
  dir: -1 | 1;
  speed: number;
  rarity: Rarity;
  /** Draw width in canvas units — rare fish are physically bigger. */
  width: number;
  /** Continuous animation clock, drives the runtime deformation. */
  animTime: number;
  state: FishState;
  /** Seconds spent in the current state. */
  stateTime: number;
  /** Which of the three telegraph ticks have already fired. */
  ticksFired: number;
  /** Vertical bob phase so fish don't move in lockstep. */
  bobPhase: number;
  /** Wind-up twitch offset, drives the visual telegraph. */
  twitch: number;
  /** Set when the fish is consumed so the renderer can fade it. */
  fade: number;
  /**
   * Pufferfish inflation, 0 (calm) to 1 (fully puffed). Eased rather than
   * switched so the swell reads as the fish reacting to being caught. Always 0
   * on the other two species.
   */
  puff: number;
  /** Velocity, only meaningful while `flung`. Canvas units per second. */
  vx: number;
  vy: number;
  /** Tumble angle in radians, only meaningful while `flung`. */
  spin: number;
}

let nextId = 1;

export function spawnFish(canvasW: number, waterTop: number, canvasH: number): Fish {
  const C = CONFIG.fish;
  const dir: -1 | 1 = Math.random() < 0.5 ? -1 : 1;

  // One roll across all three species, so the shares add up to 1 instead of
  // compounding — puffer, then rare, then whatever is left is a common.
  const roll = Math.random();
  const rarity: Rarity =
    roll < C.pufferChance
      ? "puffer"
      : roll < C.pufferChance + C.rareChance
        ? "rare"
        : "common";

  // Rare fish live deeper, so reaching one is a deliberate commitment; puffers
  // hang in the middle of the column where they are hard to avoid.
  const band =
    rarity === "rare"
      ? C.rareDepthRange
      : rarity === "puffer"
        ? C.pufferDepthRange
        : C.depthRange;
  const depth = band[0] + Math.random() * (band[1] - band[0]);

  const sizeScale =
    rarity === "rare" ? C.rareScale : rarity === "puffer" ? C.pufferScale : 1;
  const speedScale =
    rarity === "rare"
      ? C.rareSpeedScale
      : rarity === "puffer"
        ? C.pufferSpeedScale
        : 1;

  const width = C.width * sizeScale;
  const speed =
    (C.speed + (Math.random() * 2 - 1) * C.speedJitter) * speedScale;

  return {
    id: nextId++,
    // Start just off the edge it is swimming from.
    x: dir === 1 ? -width : canvasW + width,
    y: waterTop + (canvasH - waterTop) * depth,
    dir,
    speed,
    rarity,
    width,
    animTime: Math.random() * 10,
    state: "drift",
    stateTime: 0,
    ticksFired: 0,
    bobPhase: Math.random() * Math.PI * 2,
    twitch: 0,
    fade: 1,
    puff: 0,
    vx: 0,
    vy: 0,
    spin: 0,
  };
}

export interface FishUpdateEvents {
  onTick?: (n: number) => void;
  /** The catch window just opened for this fish. */
  onWindowOpen?: (f: Fish) => void;
  /** The window closed with no catch. */
  onMiss?: (f: Fish) => void;
  /** A fish passed close to the surface — used for the waterline bump. */
  onSurfacePass?: (x: number) => void;
}

/**
 * Advances one fish. The bite loop is:
 *   drift → approach → pause → windup (3 ticks) → window → hooked
 * A fish that reaches the end of the window uncaught misses and flees.
 * `hooked` is terminated by the caller, not by this function — see that case.
 */
export function updateFish(
  f: Fish,
  dt: number,
  elapsed: number,
  hookX: number,
  hookY: number,
  canvasW: number,
  waterTop: number,
  ev: FishUpdateEvents
) {
  const C = CONFIG.fish;
  f.stateTime += dt;
  // Advances faster while hooked so the thrash reads as panic.
  f.animTime += dt * (f.state === "hooked" ? 1.9 : 1);

  // A puffer inflates the moment it is caught and stays swollen through the
  // throw — on the hook and in the air are exactly the two moments the player
  // is looking straight at it and deciding whether to eat it.
  if (f.rarity === "puffer") {
    const target = f.state === "hooked" || f.state === "flung" ? 1 : 0;
    const step = dt / C.pufferInflateTime;
    f.puff = target > f.puff
      ? Math.min(1, f.puff + step)
      : Math.max(0, f.puff - step);
  }

  const distToHook = Math.hypot(f.x - hookX, f.y - hookY);
  // A hook that is out of the water is not bait. Without this, reeling a catch
  // up past your face tows the rest of the shoal along behind it.
  const hookInWater = hookY > waterTop;

  switch (f.state) {
    case "drift": {
      f.x += f.dir * f.speed * dt;
      f.y += Math.sin(elapsed * 1.6 + f.bobPhase) * 9 * dt;
      if (hookInWater && distToHook < C.noticeRadius) {
        f.state = "approach";
        f.stateTime = 0;
      }
      break;
    }

    case "approach": {
      // Steer toward the hook, but keep some of the original drift so the
      // approach reads as a curve rather than a laser lock.
      const dx = hookX - f.x;
      const dy = hookY - f.y;
      const d = Math.hypot(dx, dy) || 1;
      const approachSpeed = f.speed * C.approachSpeedMul;
      f.x += (dx / d) * approachSpeed * dt;
      f.y += (dy / d) * approachSpeed * dt;
      f.dir = dx < 0 ? -1 : 1;

      // A hook dangling above the surface must not drag free fish into the air.
      f.y = Math.max(f.y, waterTop + C.surfaceKeepOut);

      if (d < C.windUpRadius) {
        f.state = "pause";
        f.stateTime = 0;
      } else if (!hookInWater || d > C.noticeRadius * 1.5) {
        // Lost interest: the hook left the water, or simply outran the fish.
        f.state = "drift";
        f.stateTime = 0;
      }
      break;
    }

    case "pause": {
      // Dead stop. The stillness is what makes the following twitch read.
      if (f.stateTime >= C.pauseDuration) {
        f.state = "windup";
        f.stateTime = 0;
        f.ticksFired = 0;
      }
      break;
    }

    case "windup": {
      const t = f.stateTime / C.windUpDuration;
      // Three ticks at 0, 1/3, 2/3 through the wind-up, each with a matching
      // visual twitch so the audio and the animation are one event.
      const expected = Math.min(3, Math.floor(t * 3) + 1);
      while (f.ticksFired < expected) {
        ev.onTick?.(f.ticksFired);
        f.ticksFired++;
        f.twitch = 1;
      }
      f.twitch = Math.max(0, f.twitch - dt * 6);

      if (f.stateTime >= C.windUpDuration) {
        f.state = "window";
        f.stateTime = 0;
        ev.onWindowOpen?.(f);
      }
      break;
    }

    case "window": {
      // Deliberately forgiving. The player is never scored against the ticks;
      // they exist so the bite can be anticipated at all.
      f.twitch = Math.max(0, f.twitch - dt * 4);
      if (f.stateTime >= C.catchWindow) {
        ev.onMiss?.(f);
        f.state = "flee";
        f.stateTime = 0;
      }
      break;
    }

    case "hooked": {
      // Position is driven by the hook during the fight. Whether the fish is
      // actually earned is NOT decided here: only the caller knows where the
      // rippling waterline sits, and throwing it clear is the win condition.
      f.x = hookX;
      f.y = hookY + 18;
      break;
    }

    case "flee": {
      f.x += f.dir * f.speed * 2.1 * dt;
      f.y += 30 * dt;
      if (f.stateTime >= C.fleeDuration) {
        f.state = "drift";
        f.stateTime = 0;
      }
      break;
    }

    case "flung": {
      // Pure ballistics. The fish has left the hook and is the player's prize
      // arcing through the air; nothing steers it any more.
      const FL = CONFIG.fling;
      f.vy += FL.gravity * dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.spin += FL.spin * dt * (f.vx < 0 ? -1 : 1);

      // A fish that falls back into the water is simply gone — it splashes and
      // the player missed the gulp, which costs nothing.
      if (f.vy > 0 && f.y > waterTop) {
        ev.onSurfacePass?.(f.x);
        f.fade = 0;
        break;
      }

      // Fade only at the very end of the lifetime. Fading part-way through the
      // arc would make the fish invisible exactly while it is falling back
      // toward the mouth — the moment it most needs to be seen.
      const fadeStart = FL.lifetime - FL.fadeOut;
      if (f.stateTime > fadeStart) {
        f.fade = Math.max(0, 1 - (f.stateTime - fadeStart) / FL.fadeOut);
      }
      break;
    }
  }

  // A fish crossing near the surface nudges the waterline.
  if (Math.abs(f.y - waterTop) < 34) {
    ev.onSurfacePass?.(f.x);
  }
}

/** True once a fish has left the playfield and should be culled. */
export function isFishGone(f: Fish, canvasW: number, canvasH: number): boolean {
  const margin = f.width * 2;
  if (f.state === "flung") {
    // A flung fish is allowed to leave through the top of the screen, which a
    // drifting one never does — so it needs its own bounds.
    return (
      f.fade <= 0 ||
      f.stateTime > CONFIG.fling.lifetime ||
      f.y > canvasH + margin ||
      f.x < -margin ||
      f.x > canvasW + margin
    );
  }
  return f.x < -margin || f.x > canvasW + margin;
}

/** Whether this fish is currently catchable by the hook. */
export function isCatchable(f: Fish, hookX: number, hookY: number): boolean {
  if (f.state !== "window") return false;
  return Math.hypot(f.x - hookX, f.y - hookY) < CONFIG.fish.catchRadius;
}
