import { CONFIG } from "./config";

export type FishState =
  | "drift"
  | "approach"
  | "pause"
  | "windup"
  | "window"
  | "hooked"
  | "landed"
  | "flee";

export interface Fish {
  id: number;
  x: number;
  y: number;
  /** -1 = swimming left, 1 = swimming right. Sprite art faces left. */
  dir: -1 | 1;
  speed: number;
  variant: number;
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
}

let nextId = 1;

export function spawnFish(canvasW: number, waterTop: number, canvasH: number): Fish {
  const { speed, speedJitter, depthRange } = CONFIG.fish;
  const dir: -1 | 1 = Math.random() < 0.5 ? -1 : 1;
  const depth = depthRange[0] + Math.random() * (depthRange[1] - depthRange[0]);
  return {
    id: nextId++,
    // Start just off the edge it is swimming from.
    x: dir === 1 ? -CONFIG.fish.width : canvasW + CONFIG.fish.width,
    y: waterTop + (canvasH - waterTop) * depth,
    dir,
    speed: speed + (Math.random() * 2 - 1) * speedJitter,
    variant: Math.floor(Math.random() * 3),
    state: "drift",
    stateTime: 0,
    ticksFired: 0,
    bobPhase: Math.random() * Math.PI * 2,
    twitch: 0,
    fade: 1,
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
 *   drift → approach → pause → windup (3 ticks) → window (~300ms) → hooked
 * A fish that reaches the end of the window uncaught misses and flees.
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

  const distToHook = Math.hypot(f.x - hookX, f.y - hookY);

  switch (f.state) {
    case "drift": {
      f.x += f.dir * f.speed * dt;
      f.y += Math.sin(elapsed * 1.6 + f.bobPhase) * 9 * dt;
      if (distToHook < C.noticeRadius) {
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
      const approachSpeed = f.speed * 1.15;
      f.x += (dx / d) * approachSpeed * dt;
      f.y += (dy / d) * approachSpeed * dt;
      f.dir = dx < 0 ? -1 : 1;

      if (d < C.windUpRadius) {
        f.state = "pause";
        f.stateTime = 0;
      } else if (d > C.noticeRadius * 1.5) {
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
      // Position is driven by the hook during the struggle.
      f.x = hookX;
      f.y = hookY + 18;
      if (f.stateTime >= C.struggleDuration) {
        f.state = "landed";
        f.stateTime = 0;
        if (f.y < waterTop + 40) ev.onSurfacePass?.(f.x);
      }
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

    case "landed": {
      f.fade = Math.max(0, f.fade - dt * 2.5);
      break;
    }
  }

  // A fish crossing near the surface nudges the waterline.
  if (f.state !== "landed" && Math.abs(f.y - waterTop) < 34) {
    ev.onSurfacePass?.(f.x);
  }
}

/** True once a fish has left the playfield and should be culled. */
export function isFishGone(f: Fish, canvasW: number): boolean {
  if (f.state === "landed" && f.fade <= 0) return true;
  const margin = CONFIG.fish.width * 2;
  return f.x < -margin || f.x > canvasW + margin;
}

/** Whether this fish is currently catchable by the hook. */
export function isCatchable(f: Fish, hookX: number, hookY: number): boolean {
  if (f.state !== "window") return false;
  return Math.hypot(f.x - hookX, f.y - hookY) < CONFIG.fish.catchRadius;
}
