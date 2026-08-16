import { CONFIG } from "./config";

/**
 * MediaPipe wrapper.
 *
 * IMPORTANT: this module must only ever be reached through a dynamic import
 * from a client component. `@mediapipe/tasks-vision` touches `window` at module
 * scope, so pulling it into a server-rendered bundle crashes the Next build.
 */

const MEDIAPIPE_VERSION = "0.10.22-rc.20250304";
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

/** Landmark indices we care about. */
const NOSE_TIP = 1;
const UPPER_LIP_INNER = 13;
const LOWER_LIP_INNER = 14;
const FOREHEAD = 10;
const CHIN = 152;

export interface FaceSample {
  /** Mirrored, normalized 0..1 nose position. */
  noseX: number;
  noseY: number;
  /**
   * Mirrored, normalized 0..1 centre of the mouth opening.
   * Tracked separately from the nose because a falling fish has to be caught in
   * the mouth specifically, and the gap between nose and lips is most of a
   * catch radius — approximating one from the other would miss visibly.
   */
  mouthX: number;
  mouthY: number;
  /** Continuous 0..1 mouth aperture. Never a binary threshold. */
  mouth: number;
  ok: boolean;
}

/** Simple exponential moving average. */
class Ema {
  private value: number | null = null;
  constructor(private alpha: number) {}
  push(v: number) {
    this.value = this.value === null ? v : this.value + this.alpha * (v - this.value);
    return this.value;
  }
  get current() {
    return this.value ?? 0;
  }
  reset() {
    this.value = null;
  }
}

export class FaceTracker {
  private landmarker: unknown = null;
  private lastVideoTime = -1;
  private noseXEma = new Ema(CONFIG.noseEma);
  private noseYEma = new Ema(CONFIG.noseEma);
  private mouthXEma = new Ema(CONFIG.noseEma);
  private mouthYEma = new Ema(CONFIG.noseEma);
  private mouthEma = new Ema(CONFIG.mouthEma);
  private lastSample: FaceSample = {
    noseX: 0.5,
    noseY: 0.5,
    mouthX: 0.5,
    mouthY: 0.56,
    mouth: 0,
    ok: false,
  };

  ready = false;

  /**
   * Downloads the WASM bundle and the model. Called during the title screen so
   * the player never pays this cost on first play.
   */
  async load(): Promise<void> {
    const vision = await import("@mediapipe/tasks-vision");
    const fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE);
    this.landmarker = await vision.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    });
    this.ready = true;
  }

  reset() {
    this.noseXEma.reset();
    this.noseYEma.reset();
    this.mouthXEma.reset();
    this.mouthYEma.reset();
    this.mouthEma.reset();
    this.lastVideoTime = -1;
  }

  /**
   * Runs detection against the current video frame and returns a smoothed
   * sample. If no face is found we hold the previous smoothed value rather than
   * snapping to center — snapping reads as a glitch.
   */
  detect(video: HTMLVideoElement, timestampMs: number): FaceSample {
    const lm = this.landmarker as {
      detectForVideo: (v: HTMLVideoElement, t: number) => {
        faceLandmarks: Array<Array<{ x: number; y: number; z: number }>>;
      };
    } | null;

    if (!lm || video.readyState < 2) return this.lastSample;

    // MediaPipe VIDEO mode requires monotonically increasing timestamps and
    // rejects a repeated frame, so skip when the video hasn't advanced.
    if (video.currentTime === this.lastVideoTime) return this.lastSample;
    this.lastVideoTime = video.currentTime;

    let result;
    try {
      result = lm.detectForVideo(video, timestampMs);
    } catch {
      return this.lastSample;
    }

    const face = result?.faceLandmarks?.[0];
    if (!face || face.length < 200) {
      this.lastSample = { ...this.lastSample, ok: false };
      return this.lastSample;
    }

    const nose = face[NOSE_TIP];
    const upper = face[UPPER_LIP_INNER];
    const lower = face[LOWER_LIP_INNER];
    const forehead = face[FOREHEAD];
    const chin = face[CHIN];

    // The camera feed is mirrored on screen, so mirror X to match.
    const rawX = 1 - nose.x;
    const rawY = nose.y;

    // Normalize aperture by face height so it survives the player moving
    // closer to or further from the phone.
    const faceHeight = Math.abs(chin.y - forehead.y) || 1;
    const rawMouth = Math.abs(lower.y - upper.y) / faceHeight;

    this.lastSample = {
      noseX: this.noseXEma.push(rawX),
      noseY: this.noseYEma.push(rawY),
      mouthX: this.mouthXEma.push(1 - (upper.x + lower.x) / 2),
      mouthY: this.mouthYEma.push((upper.y + lower.y) / 2),
      mouth: this.mouthEma.push(rawMouth),
      ok: true,
    };
    return this.lastSample;
  }

  close() {
    const lm = this.landmarker as { close?: () => void } | null;
    lm?.close?.();
    this.landmarker = null;
    this.ready = false;
  }
}

/**
 * Projects a normalized, already-mirrored face landmark into canvas space.
 *
 * This MUST stay in lockstep with `drawCamera`, which paints the feed
 * cover-style (scale to the larger axis, centre the overflow) and mirrored.
 * Because the sample is stored pre-mirrored, the mirror cancels out and the X
 * mapping ends up identical in form to the Y one — see the note below.
 *
 * Any amplification applied here would visibly detach the rope from the face,
 * so there is deliberately none. Reach into the water comes from rope payout.
 */
export function landmarkToCanvas(
  mirroredX: number,
  y: number,
  videoW: number,
  videoH: number,
  canvasW: number,
  canvasH: number
): { x: number; y: number } {
  // Degenerate dimensions (video not ready) — fall back to a centred guess
  // rather than emitting NaN into the physics.
  if (!videoW || !videoH) {
    return { x: mirroredX * canvasW, y: y * canvasH };
  }

  const scale = Math.max(canvasW / videoW, canvasH / videoH);
  const dw = videoW * scale;
  const dh = videoH * scale;

  // drawCamera places the unmirrored image at (canvasW - dw) / 2 and then
  // reflects the whole canvas. Reflecting that offset gives back the same
  // value, so the mirrored point lands at the plain cover-fit offset.
  return {
    x: (canvasW - dw) / 2 + mirroredX * dw,
    y: (canvasH - dh) / 2 + y * dh,
  };
}

/** Maps the raw aperture ratio to a continuous 0..1 payout value. */
export function normalizeMouth(raw: number): number {
  const { rawClosed, rawOpen, curve } = CONFIG.mouth;
  const t = (raw - rawClosed) / (rawOpen - rawClosed);
  const clamped = Math.max(0, Math.min(1, t));
  return Math.pow(clamped, curve);
}
