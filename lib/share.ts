/**
 * Turning a run into something postable.
 *
 * The photo roll is the funniest thing the game produces and, until now, it
 * could not leave the page. This composites the focused print — photo, stamp,
 * archetype — into a single image so one tap hands it to the share sheet.
 *
 * Everything here runs off data URLs from the game's own canvas, so nothing
 * taints and nothing needs the network.
 */

const FOAM = "#f2ecff";
const VOID = "#120a20";
const SPLAT = "#ff2d9b";

/** Same stack the DOM uses, so the print matches what was on screen. */
const FONT = '"SF Pro Rounded", ui-rounded, Nunito, system-ui, sans-serif';

export interface PolaroidSpec {
  /** Data URL of the captured frame. */
  photo: string;
  /** Stamp sprite URL, or null to fall back to a drawn chip. */
  stamp: string | null;
  /** What the stamp says — also the fallback text. */
  stampLabel: string;
  /** The run's archetype title. */
  archetype: string;
  /** `3 fish · 1 rare · 2 eaten`. */
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

const W = 1080;
const PAD = 56;
const PHOTO_W = W - PAD * 2;
const PHOTO_H = Math.round((PHOTO_W * 13) / 9);
const CAPTION_H = 200;
const H = PAD + PHOTO_H + CAPTION_H;

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

  // --- the print itself
  ctx.fillStyle = FOAM;
  roundRect(ctx, 0, 0, W, H, 18);
  ctx.fill();

  // --- the photo
  ctx.save();
  roundRect(ctx, PAD, PAD, PHOTO_W, PHOTO_H, 6);
  ctx.clip();
  ctx.fillStyle = "#0d0722";
  ctx.fillRect(PAD, PAD, PHOTO_W, PHOTO_H);
  if (photo) drawCover(ctx, photo, PAD, PAD, PHOTO_W, PHOTO_H);
  ctx.restore();

  // --- the stamp, slapped over the top-right corner of the photo
  const sw = 380;
  const cx = PAD + PHOTO_W - sw * 0.42;
  const cy = PAD + sw * 0.36;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((-11 * Math.PI) / 180);
  if (stamp) {
    const sh = (stamp.height / stamp.width) * sw;
    ctx.drawImage(stamp, -sw / 2, -sh / 2, sw, sh);
  } else {
    // Fallback chip, in the same ink language: flat fill, heavy dark outline.
    const label = spec.stampLabel.toUpperCase();
    ctx.font = `900 62px ${FONT}`;
    const tw = ctx.measureText(label).width;
    const bw = tw + 72;
    const bh = 116;
    ctx.fillStyle = SPLAT;
    ctx.strokeStyle = VOID;
    ctx.lineWidth = 10;
    roundRect(ctx, -bw / 2, -bh / 2, bw, bh, 16);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = FOAM;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, 0, 4);
  }
  ctx.restore();

  // --- the caption band: the archetype is what makes this comparable
  const capY = PAD + PHOTO_H;
  ctx.fillStyle = VOID;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = `900 76px ${FONT}`;
  ctx.fillText(spec.archetype.toUpperCase(), PAD, capY + 92);

  ctx.fillStyle = "rgba(18,10,32,0.55)";
  ctx.font = `700 40px ${FONT}`;
  ctx.fillText(spec.tally, PAD, capY + 146);

  ctx.textAlign = "right";
  ctx.fillStyle = SPLAT;
  ctx.font = `900 34px ${FONT}`;
  ctx.fillText("NOSE FISHER", W - PAD, capY + 146);

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

  const file = new File([blob], "nose-fisher.png", { type: "image/png" });
  const text = `${spec.archetype} — ${spec.tally}. Nose Fisher.`;

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
