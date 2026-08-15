import { CONFIG } from "./config";
import type { Fish } from "./fish";
import type { Rope } from "./rope";

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
    // Camera unavailable — fall back to a calm gradient so the game still reads.
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#123f47");
    g.addColorStop(1, "#0b2e33");
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
 * The translucent water layer. Drawn AFTER submerged fish so it softens them,
 * and BEFORE the rope so the rope stays crisp on top.
 */
export function drawWaterLayer(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  baseY: number,
  elapsed: number,
  bumps: WaterBump[]
) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(0, h);
  ctx.lineTo(0, waterlineY(0, baseY, elapsed, bumps));
  for (let x = 0; x <= w; x += 8) {
    ctx.lineTo(x, waterlineY(x, baseY, elapsed, bumps));
  }
  ctx.lineTo(w, h);
  ctx.closePath();

  const g = ctx.createLinearGradient(0, baseY, 0, h);
  g.addColorStop(0, "rgba(46, 158, 158, 0.86)");
  g.addColorStop(0.45, "rgba(24, 116, 124, 0.94)");
  g.addColorStop(1, "rgba(9, 62, 74, 1)");
  ctx.globalAlpha = CONFIG.water.alpha;
  ctx.fillStyle = g;
  ctx.fill();
  ctx.globalAlpha = 1;

  // Crisp surface line so the boundary is unambiguous.
  ctx.beginPath();
  ctx.moveTo(0, waterlineY(0, baseY, elapsed, bumps));
  for (let x = 0; x <= w; x += 8) {
    ctx.lineTo(x, waterlineY(x, baseY, elapsed, bumps));
  }
  ctx.strokeStyle = "rgba(226, 250, 248, 0.75)";
  ctx.lineWidth = 3;
  ctx.stroke();
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
  ctx.globalAlpha = 0.07;
  ctx.strokeStyle = "#eafbff";
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
 * Procedural fish in the same style as the generated sprites — used when a
 * sprite fails to load. Chunky rounded body, thick black outline, flat fill.
 */
function drawProceduralFish(ctx: CanvasRenderingContext2D, w: number, variant: number) {
  const palettes = [
    ["#ff6b4a", "#ffd9c2"],
    ["#ffb43d", "#ffeccd"],
    ["#f2557f", "#ffd6e0"],
  ];
  const [body, belly] = palettes[variant % palettes.length];
  const h = w * 0.62;

  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = w * 0.055;
  ctx.strokeStyle = "#1a1410";

  // Tail
  ctx.beginPath();
  ctx.moveTo(w * 0.3, 0);
  ctx.lineTo(w * 0.5, -h * 0.36);
  ctx.lineTo(w * 0.5, h * 0.36);
  ctx.closePath();
  ctx.fillStyle = body;
  ctx.fill();
  ctx.stroke();

  // Body
  ctx.beginPath();
  ctx.ellipse(0, 0, w * 0.42, h * 0.45, 0, 0, Math.PI * 2);
  ctx.fillStyle = body;
  ctx.fill();
  ctx.stroke();

  // Belly
  ctx.beginPath();
  ctx.ellipse(-w * 0.05, h * 0.14, w * 0.3, h * 0.2, 0, 0, Math.PI * 2);
  ctx.fillStyle = belly;
  ctx.fill();

  // Eye
  ctx.beginPath();
  ctx.arc(-w * 0.24, -h * 0.12, w * 0.07, 0, Math.PI * 2);
  ctx.fillStyle = "#fffaf2";
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(-w * 0.255, -h * 0.12, w * 0.033, 0, Math.PI * 2);
  ctx.fillStyle = "#1a1410";
  ctx.fill();
}

export function drawFish(
  ctx: CanvasRenderingContext2D,
  f: Fish,
  sprites: (HTMLImageElement | null)[],
  elapsed: number
) {
  const w = CONFIG.fish.width;
  const sprite = sprites[f.variant % sprites.length];

  ctx.save();
  ctx.globalAlpha = f.fade;
  ctx.translate(f.x, f.y);

  // Wind-up twitch: a quick rotational shudder synchronized to each tick.
  const twitchAngle = f.twitch * Math.sin(elapsed * 60) * 0.22;
  const struggle =
    f.state === "hooked" ? Math.sin(elapsed * 22) * 0.34 : 0;
  ctx.rotate(twitchAngle + struggle);

  // Sprite art faces left, so flip when swimming right.
  if (f.dir === 1) ctx.scale(-1, 1);

  // A gentle scale pulse during the wind-up reads as "loading up".
  const s = 1 + f.twitch * 0.1;
  ctx.scale(s, s);

  if (sprite && sprite.complete && sprite.naturalWidth > 0) {
    const aspect = sprite.naturalHeight / sprite.naturalWidth;
    ctx.drawImage(sprite, -w / 2, (-w * aspect) / 2, w, w * aspect);
  } else {
    drawProceduralFish(ctx, w, f.variant);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Rope + hook
// ---------------------------------------------------------------------------

function drawProceduralHook(ctx: CanvasRenderingContext2D, size: number) {
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // Bead
  ctx.beginPath();
  ctx.arc(0, -size * 0.28, size * 0.2, 0, Math.PI * 2);
  ctx.fillStyle = "#ffb43d";
  ctx.fill();
  ctx.lineWidth = size * 0.09;
  ctx.strokeStyle = "#1a1410";
  ctx.stroke();

  // Shank + curve
  ctx.beginPath();
  ctx.moveTo(0, -size * 0.12);
  ctx.lineTo(0, size * 0.2);
  ctx.arc(-size * 0.17, size * 0.2, size * 0.17, 0, Math.PI, false);
  ctx.lineTo(-size * 0.34, size * 0.02);
  ctx.strokeStyle = "#1a1410";
  ctx.lineWidth = size * 0.13;
  ctx.stroke();
  ctx.strokeStyle = "#d8dde0";
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

  // Dark underlay gives the rope a thick cartoon outline against the water.
  ctx.beginPath();
  ctx.moveTo(nodes[0].x, nodes[0].y);
  for (let i = 1; i < nodes.length - 1; i++) {
    const xc = (nodes[i].x + nodes[i + 1].x) / 2;
    const yc = (nodes[i].y + nodes[i + 1].y) / 2;
    ctx.quadraticCurveTo(nodes[i].x, nodes[i].y, xc, yc);
  }
  ctx.lineTo(nodes[nodes.length - 1].x, nodes[nodes.length - 1].y);
  ctx.strokeStyle = "#1a1410";
  ctx.lineWidth = CONFIG.rope.lineWidth + 3;
  ctx.stroke();
  ctx.strokeStyle = "#fff3dc";
  ctx.lineWidth = CONFIG.rope.lineWidth;
  ctx.stroke();

  // Hook
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
      ctx.strokeStyle = `rgba(255, 214, 120, ${0.34 * glow * (1 - r / 3) * (1 - pulse * 0.4)})`;
      ctx.lineWidth = 4;
      ctx.stroke();
    }
    // A downward arrow of light, biasing attention toward "go deeper".
    ctx.beginPath();
    ctx.moveTo(hook.x, hook.y + 30 + pulse * 10);
    ctx.lineTo(hook.x, hook.y + 58 + pulse * 14);
    ctx.strokeStyle = `rgba(255, 214, 120, ${0.5 * glow})`;
    ctx.lineWidth = 5;
    ctx.stroke();
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

/** Expanding ring, used for the catch flash. Drawn procedurally, never a sprite. */
export function drawPulseRing(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  t: number
) {
  const r = 18 + t * 150;
  const alpha = Math.max(0, 1 - t);
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(255, 246, 214, ${alpha * 0.9})`;
  ctx.lineWidth = 8 * alpha + 1;
  ctx.stroke();
  ctx.restore();
}

/** Tension shimmer along the rope while a fish fights. */
export function drawTension(ctx: CanvasRenderingContext2D, rope: Rope, amount: number) {
  if (amount <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = amount * 0.8;
  ctx.strokeStyle = "#fff1b8";
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
