import { CONFIG } from "./config";

export interface RopeNode {
  x: number;
  y: number;
  /** Previous position — Verlet integration derives velocity from this. */
  px: number;
  py: number;
  /** Accumulated force for the current frame, cleared after integration. */
  fx: number;
  fy: number;
  mass: number;
}

/**
 * A Verlet chain anchored at node 0 (the nose) with a weighted hook at the end.
 *
 * Design notes on feel:
 *  - The anchor is moved directly each frame. Because every other node
 *    integrates from its own previous position, moving the anchor does NOT
 *    teleport the chain: momentum propagates down through the constraints over
 *    several frames. That lag is the swing, and it is intentional.
 *  - We run only 2-3 solver iterations. More iterations converge toward a rigid
 *    rod, which kills the whip entirely.
 */
export class Rope {
  nodes: RopeNode[] = [];
  /** Current rest length of a single segment. Grows as rope pays out. */
  segmentLength: number;
  /** 0..1 payout, chased toward the mouth aperture. */
  payout = 0;

  constructor(anchorX: number, anchorY: number) {
    const { segments, segmentLengthMin, hookMass } = CONFIG.rope;
    this.segmentLength = segmentLengthMin;
    for (let i = 0; i <= segments; i++) {
      const y = anchorY + i * segmentLengthMin;
      this.nodes.push({
        x: anchorX,
        y,
        px: anchorX,
        py: y,
        fx: 0,
        fy: 0,
        mass: i === segments ? hookMass : 1,
      });
    }
  }

  get hook(): RopeNode {
    return this.nodes[this.nodes.length - 1];
  }

  get anchor(): RopeNode {
    return this.nodes[0];
  }

  /** Hook velocity in units/sec, derived from the Verlet position history. */
  hookVelocity(dt: number): { vx: number; vy: number } {
    const h = this.hook;
    if (dt <= 0) return { vx: 0, vy: 0 };
    return { vx: (h.x - h.px) / dt, vy: (h.y - h.py) / dt };
  }

  /**
   * THE force entry point. Currents, fish struggle, and any future hazard all
   * route through here. `index` selects the node; use `hookIndex` for the hook.
   */
  applyForce(index: number, fx: number, fy: number) {
    const n = this.nodes[index];
    if (!n) return;
    n.fx += fx;
    n.fy += fy;
  }

  get hookIndex() {
    return this.nodes.length - 1;
  }

  /** Applies a force spread across the middle of the chain (bows the rope). */
  applyMidChainForce(fx: number, fy: number) {
    const n = this.nodes.length;
    for (let i = 1; i < n - 1; i++) {
      // Bell-shaped weight peaking at the chain's midpoint.
      const t = i / (n - 1);
      const w = Math.sin(t * Math.PI);
      this.applyForce(i, fx * w, fy * w);
    }
  }

  /**
   * Chase the target payout (driven by mouth aperture) and update rest length.
   * Asymmetric rates: paying out feels loose, retracting feels deliberate.
   */
  updatePayout(target: number, dt: number) {
    const { payoutRate, retractRate, segmentLengthMin, segmentLengthMax } = CONFIG.rope;
    const rate = target > this.payout ? payoutRate : retractRate;
    const delta = target - this.payout;
    const step = Math.sign(delta) * Math.min(Math.abs(delta), rate * dt);
    this.payout = Math.max(0, Math.min(1, this.payout + step));
    this.segmentLength =
      segmentLengthMin + (segmentLengthMax - segmentLengthMin) * this.payout;
  }

  /**
   * Verlet integrate + constraint solve.
   * @param waterY  Current surface height; nodes below it get buoyancy and drag.
   */
  step(dt: number, anchorX: number, anchorY: number, waterY: number) {
    const {
      gravity,
      swingDamping,
      hookDamping,
      solverIterations,
      underwaterGravityScale,
      underwaterDrag,
    } = CONFIG.rope;

    const hookIdx = this.hookIndex;

    // --- integrate ---------------------------------------------------------
    for (let i = 1; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      const submerged = n.y > waterY;

      let vx = (n.x - n.px) * (i === hookIdx ? hookDamping : swingDamping);
      let vy = (n.y - n.py) * (i === hookIdx ? hookDamping : swingDamping);

      if (submerged) {
        vx *= underwaterDrag;
        vy *= underwaterDrag;
      }

      const g = gravity * (submerged ? underwaterGravityScale : 1);
      const ax = n.fx / n.mass;
      const ay = n.fy / n.mass + g;

      n.px = n.x;
      n.py = n.y;
      n.x += vx + ax * dt * dt;
      n.y += vy + ay * dt * dt;

      n.fx = 0;
      n.fy = 0;
    }

    // --- pin the anchor to the nose ---------------------------------------
    const a = this.nodes[0];
    a.px = a.x;
    a.py = a.y;
    a.x = anchorX;
    a.y = anchorY;
    a.fx = 0;
    a.fy = 0;

    // --- solve distance constraints ---------------------------------------
    for (let k = 0; k < solverIterations; k++) {
      for (let i = 0; i < this.nodes.length - 1; i++) {
        const n1 = this.nodes[i];
        const n2 = this.nodes[i + 1];
        let dx = n2.x - n1.x;
        let dy = n2.y - n1.y;
        const dist = Math.hypot(dx, dy) || 0.0001;
        const diff = (dist - this.segmentLength) / dist;

        // Node 0 is immovable; otherwise split the correction by inverse mass.
        const w1 = i === 0 ? 0 : 1 / n1.mass;
        const w2 = 1 / n2.mass;
        const wsum = w1 + w2 || 1;

        dx *= diff;
        dy *= diff;
        n1.x += dx * (w1 / wsum);
        n1.y += dy * (w1 / wsum);
        n2.x -= dx * (w2 / wsum);
        n2.y -= dy * (w2 / wsum);
      }
    }
  }
}

/**
 * Environmental current. Two sine bands at different rates so the drift is
 * readable but never perfectly predictable — the player has to counter-steer.
 */
export function currentForce(elapsed: number): number {
  const { currentStrength, currentFrequency, currentFrequency2 } = CONFIG.forces;
  const a = Math.sin(elapsed * Math.PI * 2 * currentFrequency);
  const b = Math.sin(elapsed * Math.PI * 2 * currentFrequency2 + 1.7) * 0.45;
  return (a + b) * currentStrength;
}
