/**
 * Turning a run into something postable.
 *
 * The photo roll is the funniest thing the game produces and, until now, it
 * could not leave the page. This composites the focused print — photo, stamp,
 * score — into a single image so one tap hands it to the share sheet.
 *
 * Everything here runs off data URLs from the game's own canvas, so nothing
 * taints and nothing needs the network.
 *
 * ---------------------------------------------------------------------------
 * Layout is a 1:1 port of the `Share Card` frame in the effect spec file
 * (node 295707:3452, 699 x 1083). Every number below is that frame's value
 * multiplied by S, so the card can be re-rendered at any export width without
 * the proportions drifting. Do not hand-tune a single figure — change S.
 * ---------------------------------------------------------------------------
 */

const VOID = "#120a20";
const SPLAT = "#ff2d9b";
const FOAM = "#f2ecff";
/** The well behind the photo. Only ever visible if a capture failed to load. */
const WELL = "#d9d9d9";

/** Same stack the DOM uses, so the print matches what was on screen. */
const FONT = '"SF Pro Rounded", ui-rounded, Nunito, system-ui, sans-serif';

/** The game's name as it appears on the card. */
const WORDMARK = ["Fisherman’s", "Nose"];

// --------------------------------------------------------------- geometry
/** Design frame, in Figma units. */
const D_W = 699;
const D_H = 1083;
/** Export width. Everything else follows from the ratio. */
const W = 1080;
const S = W / D_W;
const H = Math.round(D_H * S);

/** Scale a Figma unit into export space. */
const u = (n: number) => n * S;

/** The photo well: inset 71 on both sides, 59 from the top, 881 tall. */
const PHOTO_X = u(71);
const PHOTO_Y = u(59);
const PHOTO_W = u(D_W - 71 * 2);
const PHOTO_H = u(881);

/**
 * The caption row. In the frame it is a 564-wide space-between flex box at
 * y=950 — which starts 10px BELOW the photo, so the two never touch.
 */
const CAP_X = u(67.5);
const CAP_W = u(564);
/** Vertical centre of the row, which both labels align to. */
const CAP_MID = u(950 + 108 / 2);
const SCORE_SIZE = u(96);
const MARK_SIZE = u(40);
const MARK_LEADING = u(54);

/**
 * The stamp, slapped over the top-right corner. The frame puts its box at
 * (411, -52, 316 x 307) — overhanging the top and right edges, which is fine in
 * Figma because the frame does not clip and the export canvas just grows.
 *
 * A share PNG has no such luxury: the overhang would be cut off, and this
 * sprite has ZERO transparent padding, so the cut lands on real ink — the tail
 * and the last stroke of CAUGHT. So the frame position is treated as a target
 * and then clamped inside the card by the smallest translation that fits.
 * Nothing is scaled down: the stamp keeps its designed size and its overlap
 * with the photo's top-right corner, it just stops hanging off.
 */
const STAMP_W = u(315.959);
/** The frame's box, top-left, in export space. */
const STAMP_X = u(411);
const STAMP_Y = u(-52);
/** Breathing room kept between the stamp and the card edge. */
const STAMP_INSET = u(12);

export interface PolaroidSpec {
  /** Data URL of the captured frame. */
  photo: string;
  /** Stamp sprite URL, or null to fall back to a drawn chip. */
  stamp: string | null;
  /** What the stamp says — also the fallback text. */
  stampLabel: string;
  /** The run's total. This is the comparable half of the result. */
  score: number;
  /** The run's archetype title. Carried in the share TEXT, not on the card. */
  archetype: string;
  /** `3 fish · 1 rare · 2 eaten`. Also share text only. */
  tally: string;
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** Rounded rect path, since `roundRect` is still missing on older Safari. */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Cover-fit, so a print is never letterboxed. */
function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number
) {
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

export async function composePolaroid(spec: PolaroidSpec): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const [photo, stamp] = await Promise.all([
    loadImage(spec.photo),
    spec.stamp ? loadImage(spec.stamp) : Promise.resolve(null),
  ]);

  // --- the card. Square corners: the frame has no radius, and rounding it
  //     made the overhanging stamp read as a sticker on a button.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  // --- the photo
  ctx.save();
  ctx.beginPath();
  ctx.rect(PHOTO_X, PHOTO_Y, PHOTO_W, PHOTO_H);
  ctx.clip();
  ctx.fillStyle = WELL;
  ctx.fillRect(PHOTO_X, PHOTO_Y, PHOTO_W, PHOTO_H);
  if (photo) drawCover(ctx, photo, PHOTO_X, PHOTO_Y, PHOTO_W, PHOTO_H);
  ctx.restore();

  // --- the stamp. The clip stays as a backstop, but with the clamp below
  //     nothing should ever reach it.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.clip();
  if (stamp) {
    // Height follows the sprite, not the frame: the frame instance is scaled
    // very slightly non-uniformly, and squashing the artwork to match is worse
    // than being ~7px off the box.
    const sh = (stamp.height / stamp.width) * STAMP_W;
    const sx = clamp(STAMP_X, STAMP_INSET, W - STAMP_W - STAMP_INSET);
    const sy = clamp(STAMP_Y, STAMP_INSET, H - sh - STAMP_INSET);
    ctx.drawImage(stamp, sx, sy, STAMP_W, sh);
  } else {
    // Fallback chip, in the same ink language: flat fill, heavy dark outline.
    // Measured first, because its width is set by the label and it has to be
    // clamped on its own terms rather than the sprite's.
    const label = spec.stampLabel.toUpperCase();
    ctx.font = `900 ${u(62)}px ${FONT}`;
    const bw = ctx.measureText(label).width + u(72);
    const bh = u(116);
    ctx.translate(
      clamp(STAMP_X + STAMP_W / 2, STAMP_INSET + bw / 2, W - STAMP_INSET - bw / 2),
      STAMP_INSET + bh / 2
    );
    ctx.fillStyle = SPLAT;
    ctx.strokeStyle = VOID;
    ctx.lineWidth = u(10);
    roundRect(ctx, -bw / 2, -bh / 2, bw, bh, u(16));
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = FOAM;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, 0, 0);
  }
  ctx.restore();

  // --- the caption row: the number on the left, the wordmark on the right.
  //     `middle` baseline on both so they sit on one optical line despite the
  //     two-and-a-half-times size difference.
  ctx.fillStyle = VOID;
  ctx.textBaseline = "middle";

  ctx.textAlign = "left";
  ctx.font = `900 ${SCORE_SIZE}px ${FONT}`;
  const pts = `${spec.score} ${Math.abs(spec.score) === 1 ? "pt" : "pts"}`;
  ctx.fillText(pts, CAP_X, CAP_MID);

  // Two lines, right-aligned, stacked around the same centre.
  ctx.textAlign = "right";
  ctx.font = `400 ${MARK_SIZE}px ${FONT}`;
  const markRight = CAP_X + CAP_W;
  const markTop = CAP_MID - ((WORDMARK.length - 1) * MARK_LEADING) / 2;
  WORDMARK.forEach((line, i) => {
    ctx.fillText(line, markRight, markTop + i * MARK_LEADING);
  });

  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
}

export type ShareResult = "shared" | "downloaded" | "failed";

/**
 * Hand the composed print to the OS share sheet, or fall back to a download.
 *
 * `navigator.share` has to be called from inside the tap that triggered it on
 * iOS, and the compose step is async — so the blob is built first and the
 * share call is the last thing that happens in the handler.
 */
export async function sharePolaroid(spec: PolaroidSpec): Promise<ShareResult> {
  const blob = await composePolaroid(spec);
  if (!blob) return "failed";

  const file = new File([blob], "fishermans-nose.png", { type: "image/png" });
  // The card carries the number; the text carries the verdict behind it.
  const text = `${spec.score} pts — ${spec.archetype}. ${spec.tally}${spec.tally}. Fisherman’s Nose.`;

  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], text });
      return "shared";
    }
  } catch (err) {
    // An abort is the user closing the sheet — not a failure worth reporting.
    if ((err as Error)?.name === "AbortError") return "shared";
  }

  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "nose-fisher.png";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return "downloaded";
  } catch {
    return "failed";
  }
}
