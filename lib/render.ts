import { CONFIG } from "./config";
import type { Fish } from "./fish";
import type { Rope } from "./rope";

const INK = CONFIG.ink;

/** A transient bump in the waterline, from a fish pass or a landed catch. */
export interface WaterBump {
  x: number;
  strength: number;
  age: number;
}

/** Height of the waterline at a given x, including all active bumps. */
export function waterlineY(
  x: number,
  baseY: number,
  elapsed: number,
  bumps: WaterBump[]
): number {
  const { waveAmplitude, waveLength, waveSpeed, bumpAmplitude, bumpDecay, bumpWidth } =
    CONFIG.water;

  // Two sines at different rates keep the surface from looking mechanical.
  let y =
    baseY +
    Math.sin(x / waveLength + elapsed * waveSpeed) * waveAmplitude +
    Math.sin(x / (waveLength * 0.43) - elapsed * waveSpeed * 1.7) * waveAmplitude * 0.35;

  for (const b of bumps) {
    const decay = Math.max(0, 1 - b.age / bumpDecay);
    if (decay <= 0) continue;
    const dx = (x - b.x) / bumpWidth;
    const falloff = Math.exp(-dx * dx);
    // Ring out rather than just fading, so a catch reads as a splash.
    const ring = Math.cos(b.age * 18) * decay * decay;
    y -= bumpAmplitude * b.strength * falloff * ring;
  }
  return y;
}

/** Draws the mirrored camera feed to fill the canvas, cover-style. */
export function drawCamera(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement | null,
  w: number,
  h: number
) {
  if (!video || video.readyState < 2) {
    // Camera unavailable — fall back to the ink void so the game still reads.
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, INK.voidTop);
    g.addColorStop(1, INK.voidBottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    return;
  }

  const vw = video.videoWidth || w;
  const vh = video.videoHeight || h;
  const scale = Math.max(w / vw, h / vh);
  const dw = vw * scale;
  const dh = vh * scale;

  ctx.save();
  // Mirror horizontally so the player's movement matches their intuition.
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, (w - dw) / 2, (h - dh) / 2, dw, dh);
  ctx.restore();
}

/**
 * The translucent ink water layer. Drawn AFTER submerged fish so it softens
 * them, and BEFORE the rope so the rope stays crisp on top.
 */
export function drawWaterLayer(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  baseY: number,
  elapsed: number,
  bumps: WaterBump[]
) {
  // Sample the surface ONCE per frame and reuse the points for the fill and
  // both strokes. Recomputing the sine + every active bump three times per
  // frame was pure waste.
  const STEP = 8;
  const pts: number[] = [];
  for (let x = 0; x <= w; x += STEP) pts.push(waterlineY(x, baseY, elapsed, bumps));

  const tracePath = () => {
    ctx.beginPath();
    ctx.moveTo(0, pts[0]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(i * STEP, pts[i]);
  };

  ctx.save();
  tracePath();
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();

  const g = ctx.createLinearGradient(0, baseY, 0, h);
  g.addColorStop(0, INK.waterTop);
  g.addColorStop(0.45, INK.waterMid);
  g.addColorStop(1, INK.waterDeep);
  ctx.globalAlpha = CONFIG.water.alpha;
  ctx.fillStyle = g;
  ctx.fill();
  ctx.globalAlpha = 1;

  // Neon surface line, doubled: a soft glow under a crisp core.
  ctx.lineJoin = "round";
  ctx.strokeStyle = INK.surface;
  tracePath();
  ctx.globalAlpha = 0.18;
  ctx.lineWidth = 11;
  ctx.stroke();
  tracePath();
  ctx.globalAlpha = 0.95;
  ctx.lineWidth = 3.5;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.restore();
}

/** Procedural caustic bands, drawn over the water layer at low alpha. */
export function drawCaustics(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  baseY: number,
  elapsed: number
) {
  ctx.save();
  ctx.globalAlpha = 0.09;
  ctx.strokeStyle = INK.caustic;
  ctx.lineWidth = 14;
  for (let i = 0; i < 5; i++) {
    const y = baseY + 70 + i * ((h - baseY) / 5);
    ctx.beginPath();
    for (let x = 0; x <= w; x += 14) {
      const yy = y + Math.sin(x / 90 + elapsed * 0.8 + i * 1.4) * 11;
      if (x === 0) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Fish
// ---------------------------------------------------------------------------

/**
 * Procedural fish in the ink style — used when a sprite fails to load.
 * Angular chunky body, thick near-black outline, flat neon fill.
 */
function drawProceduralFish(ctx: CanvasRenderingContext2D, w: number, rare: boolean) {
  const body = rare ? "#ffc61e" : "#ff2d9b";
  const belly = rare ? "#ff8a2b" : "#ffe9a3";
  const h = w * 0.62;

  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = w * 0.075;
  ctx.strokeStyle = "#120a20";

  // Tail — angular, not rounded.
  ctx.beginPath();
  ctx.moveTo(w * 0.28, 0);
  ctx.lineTo(w * 0.52, -h * 0.4);
  ctx.lineTo(w * 0.44, 0);
  ctx.lineTo(w * 0.52, h * 0.4);
  ctx.closePath();
  ctx.fillStyle = body;
  ctx.fill();
  ctx.stroke();

  // Body — a hard-edged lozenge rather than an ellipse.
  ctx.beginPath();
  ctx.moveTo(-w * 0.46, 0);
  ctx.lineTo(-w * 0.16, -h * 0.44);
  ctx.lineTo(w * 0.22, -h * 0.3);
  ctx.lineTo(w * 0.32, 0);
  ctx.lineTo(w * 0.22, h * 0.3);
  ctx.lineTo(-w * 0.16, h * 0.44);
  ctx.closePath();
  ctx.fillStyle = body;
  ctx.fill();
  ctx.stroke();

  // Belly flash.
  ctx.beginPath();
  ctx.moveTo(-w * 0.24, h * 0.1);
  ctx.lineTo(w * 0.02, h * 0.32);
  ctx.lineTo(w * 0.16, h * 0.06);
  ctx.closePath();
  ctx.fillStyle = belly;
  ctx.fill();

  // Angular slanted eye.
  ctx.beginPath();
  ctx.moveTo(-w * 0.3, -h * 0.16);
  ctx.lineTo(-w * 0.16, -h * 0.22);
  ctx.lineTo(-w * 0.18, -h * 0.04);
  ctx.closePath();
  ctx.fillStyle = "#120a20";
  ctx.fill();
}

/**
 * Draws a sprite as vertical slices, each vertically offset by a travelling
 * sine wave. Head stiff, tail whipping — the same math the exported sprite
 * sheets were baked from, run live so it isn't locked to a frame count.
 */
function drawDeformed(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  w: number,
  h: number,
  t: number,
  cfg: { tailAmp: number; waveLength: number; hz: number; archAmp?: number }
) {
  const { slices, stiffness } = CONFIG.deform;
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  const sliceW = iw / slices;

  for (let i = 0; i < slices; i++) {
    const u = slices > 1 ? i / (slices - 1) : 0; // 0 at head (left), 1 at tail
    const ramp = Math.pow(u, stiffness);

    let dy =
      cfg.tailAmp * h * ramp * Math.sin(2 * Math.PI * (t * cfg.hz - u / cfg.waveLength));
    if (cfg.archAmp) {
      dy +=
        cfg.archAmp * h * Math.sin(Math.PI * u) * Math.sin(2 * Math.PI * t * cfg.hz);
    }

    ctx.drawImage(
      img,
      i * sliceW,
      0,
      sliceW,
      ih,
      -w / 2 + (i / slices) * w,
      -h / 2 + dy,
      w / slices + 1, // +1 closes the seam between slices
      h
    );
  }
}

export function drawFish(
  ctx: CanvasRenderingContext2D,
  f: Fish,
  sprites: { common: HTMLImageElement | null; rare: HTMLImageElement | null },
  elapsed: number
) {
  const rare = f.rarity === "rare";
  const sprite = rare ? sprites.rare : sprites.common;
  const w = f.width;

  ctx.save();
  ctx.globalAlpha = f.fade;
  ctx.translate(f.x, f.y);

  // Rarity is signalled procedurally, not baked into the sprite — it scales
  // cleanly at any size and reads at 96px where sprite detail would not.
  if (rare && f.state !== "flung") {
    drawRarityGlow(ctx, w, elapsed);
  }

  const hooked = f.state === "hooked";
  const anim = hooked ? CONFIG.deform.hooked : CONFIG.deform.swim;

  // Whole-body roll. Sharper and faster while fighting the hook.
  const roll = anim.rot * Math.sin(2 * Math.PI * f.animTime * anim.hz);
  // The wind-up twitch is a separate high-frequency shudder on top.
  const twitchAngle = f.twitch * Math.sin(elapsed * 60) * 0.22;
  // A thrown fish tumbles freely — that spin is the whole payoff of the fling.
  ctx.rotate(f.state === "flung" ? f.spin : roll + twitchAngle);

  // Sprite art faces left, so flip when swimming right.
  if (f.dir === 1) ctx.scale(-1, 1);

  const s = 1 + f.twitch * 0.1;
  ctx.scale(s, s);

  if (sprite && sprite.complete && sprite.naturalWidth > 0) {
    const h = w * (sprite.naturalHeight / sprite.naturalWidth);
    drawDeformed(ctx, sprite, w, h, f.animTime, anim);
  } else {
    drawProceduralFish(ctx, w, rare);
  }
  ctx.restore();
}

/** Pulsing ink ring + orbiting flecks. The entire rare-fish tell. */
function drawRarityGlow(ctx: CanvasRenderingContext2D, w: number, elapsed: number) {
  const pulse = (Math.sin(elapsed * 3.4) + 1) / 2;

  ctx.save();
  for (let r = 0; r < 3; r++) {
    const radius = w * (0.5 + r * 0.14) + pulse * 9;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.strokeStyle = INK.rareGlow;
    ctx.globalAlpha = 0.3 * (1 - r / 3) * (0.55 + pulse * 0.45);
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  // Flecks of ink orbiting the fish.
  ctx.globalAlpha = 0.75;
  ctx.fillStyle = INK.rareGlow;
  for (let i = 0; i < 5; i++) {
    const a = elapsed * 1.1 + (i / 5) * Math.PI * 2;
    const rad = w * 0.62 + Math.sin(elapsed * 2.6 + i) * 6;
    const px = Math.cos(a) * rad;
    const py = Math.sin(a) * rad * 0.55;
    const sz = 2.5 + Math.sin(elapsed * 4 + i * 2) * 1.2;
    ctx.beginPath();
    ctx.arc(px, py, Math.max(0.6, sz), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Rope + hook
// ---------------------------------------------------------------------------

function drawProceduralHook(ctx: CanvasRenderingContext2D, size: number) {
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  ctx.beginPath();
  ctx.arc(0, -size * 0.28, size * 0.2, 0, Math.PI * 2);
  ctx.fillStyle = "#ff8a2b";
  ctx.fill();
  ctx.lineWidth = size * 0.11;
  ctx.strokeStyle = "#120a20";
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(0, -size * 0.12);
  ctx.lineTo(0, size * 0.2);
  ctx.arc(-size * 0.17, size * 0.2, size * 0.17, 0, Math.PI, false);
  ctx.lineTo(-size * 0.34, size * 0.02);
  ctx.strokeStyle = "#120a20";
  ctx.lineWidth = size * 0.15;
  ctx.stroke();
  ctx.strokeStyle = "#eef4f8";
  ctx.lineWidth = size * 0.07;
  ctx.stroke();
}

export function drawRope(
  ctx: CanvasRenderingContext2D,
  rope: Rope,
  hookSprite: HTMLImageElement | null,
  glow: number,
  elapsed: number
) {
  const nodes = rope.nodes;

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  const trace = () => {
    ctx.beginPath();
    ctx.moveTo(nodes[0].x, nodes[0].y);
    for (let i = 1; i < nodes.length - 1; i++) {
      const xc = (nodes[i].x + nodes[i + 1].x) / 2;
      const yc = (nodes[i].y + nodes[i + 1].y) / 2;
      ctx.quadraticCurveTo(nodes[i].x, nodes[i].y, xc, yc);
    }
    ctx.lineTo(nodes[nodes.length - 1].x, nodes[nodes.length - 1].y);
  };

  // Dark underlay gives the rope a thick stencil outline against the water.
  trace();
  ctx.strokeStyle = INK.ropeOutline;
  ctx.lineWidth = CONFIG.rope.lineWidth + 3.5;
  ctx.stroke();
  trace();
  ctx.strokeStyle = INK.rope;
  ctx.lineWidth = CONFIG.rope.lineWidth;
  ctx.stroke();

  const hook = rope.hook;
  const prev = nodes[nodes.length - 2];
  // Angle away from straight-down. Zero when the line hangs vertically, so the
  // hook keeps its bead pointing back up the rope as it swings.
  const angle = Math.atan2(hook.x - prev.x, hook.y - prev.y);

  // Glow + downward pulse when a fish sits below current reach. This is the
  // whole tutorial: it tells the player to open their mouth without words.
  if (glow > 0.01) {
    const pulse = (Math.sin(elapsed * 5) + 1) / 2;
    for (let r = 0; r < 3; r++) {
      const radius = 26 + r * 16 + pulse * 14;
      ctx.beginPath();
      ctx.arc(hook.x, hook.y + 10 + pulse * 12, radius, 0, Math.PI * 2);
      ctx.strokeStyle = INK.surface;
      ctx.globalAlpha = 0.34 * glow * (1 - r / 3) * (1 - pulse * 0.4);
      ctx.lineWidth = 4;
      ctx.stroke();
    }
    ctx.globalAlpha = 0.55 * glow;
    ctx.beginPath();
    ctx.moveTo(hook.x, hook.y + 30 + pulse * 10);
    ctx.lineTo(hook.x, hook.y + 58 + pulse * 14);
    ctx.strokeStyle = INK.surface;
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  ctx.save();
  ctx.translate(hook.x, hook.y);
  ctx.rotate(-angle);
  const size = 46;
  if (hookSprite && hookSprite.complete && hookSprite.naturalWidth > 0) {
    const aspect = hookSprite.naturalHeight / hookSprite.naturalWidth;
    // The bead sits at the top of the sprite, so hang it from just above the
    // last rope node — that is where the line actually terminates.
    ctx.drawImage(hookSprite, -size / 2, -size * 0.1, size, size * aspect);
  } else {
    drawProceduralHook(ctx, size);
  }
  ctx.restore();
  ctx.restore();
}

/**
 * Ink splat burst for the catch flash — jagged spikes and flung droplets,
 * drawn procedurally so it scales and never repeats exactly.
 */
export function drawPulseRing(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  t: number,
  seed = 0
) {
  const alpha = Math.max(0, 1 - t);
  if (alpha <= 0) return;

  const r = 18 + t * 130;
  const spikes = 11;

  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha = alpha * 0.9;

  // Ragged star — alternating long spikes and short valleys.
  ctx.beginPath();
  for (let i = 0; i <= spikes * 2; i++) {
    const a = (i / (spikes * 2)) * Math.PI * 2;
    // Deterministic per-flash jitter so each splat has its own shape.
    const jitter = 0.72 + 0.4 * Math.abs(Math.sin(i * 12.9898 + seed * 78.233));
    const rad = i % 2 === 0 ? r * jitter : r * 0.5 * jitter;
    const px = Math.cos(a) * rad;
    const py = Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.strokeStyle = INK.splat;
  ctx.lineWidth = 6 * alpha + 1.5;
  ctx.lineJoin = "round";
  ctx.stroke();

  // Droplets flung outward, decelerating.
  ctx.fillStyle = INK.splat;
  ctx.globalAlpha = alpha * 0.8;
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + seed;
    const rad = r * (1.15 + 0.35 * Math.sin(i * 3.1 + seed));
    ctx.beginPath();
    ctx.arc(Math.cos(a) * rad, Math.sin(a) * rad, Math.max(0.5, 5 * alpha), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Tension shimmer along the rope while a fish fights. */
export function drawTension(ctx: CanvasRenderingContext2D, rope: Rope, amount: number) {
  if (amount <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = amount * 0.8;
  ctx.strokeStyle = INK.tension;
  ctx.lineWidth = 1.5;
  const nodes = rope.nodes;
  for (let i = 1; i < nodes.length; i++) {
    const n = nodes[i];
    const p = nodes[i - 1];
    const dx = n.x - p.x;
    const dy = n.y - p.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const off = Math.sin(i * 1.9) * 5 * amount;
    ctx.beginPath();
    ctx.moveTo(p.x + nx * off, p.y + ny * off);
    ctx.lineTo(n.x + nx * off, n.y + ny * off);
    ctx.stroke();
  }
  ctx.restore();
}
