/**
 * Single source of truth for every tuning value in the game.
 * Nothing outside this file should hard-code a magic number that affects feel.
 */

export const CONFIG = {
  // ---------------------------------------------------------------- run
  /** Length of one run, in seconds. */
  runDuration: 30,
  /** Seconds without a mouth-open before the hint appears. */
  mouthHintDelay: 5,

  // ------------------------------------------------------------- tracking
  /** EMA smoothing factor for nose position. Higher = snappier, noisier. */
  noseEma: 0.35,
  /** EMA smoothing factor for mouth aperture. Slightly heavier to kill jitter. */
  mouthEma: 0.25,

  /**
   * Non-linear amplification of nose Y.
   * Raw nose Y sits in a narrow band (the player barely moves their head).
   * We remap that band to the full playfield with an ease curve so small
   * movements near the top are gentle and the bottom is still reachable.
   */
  noseY: {
    /** Raw normalized nose Y treated as "top of range". */
    inputMin: 0.3,
    /** Raw normalized nose Y treated as "bottom of range". */
    inputMax: 0.62,
    /** Exponent applied to the normalized band. <1 expands the low end. */
    curve: 0.78,
    /** Extra multiplier on the mapped result. */
    gain: 1.0,
  },

  /** Nose X amplification about the center. 1 = raw, >1 = amplified. */
  noseXGain: 1.35,

  /** Vertical span of the screen the anchor is allowed to occupy (0..1). */
  anchorYRange: [0.05, 0.36] as [number, number],

  // ---------------------------------------------------------------- mouth
  /**
   * Mouth aperture is |upperLip.y - lowerLip.y| divided by face height,
   * then remapped from this raw band to a continuous 0..1.
   * Deliberately NOT a binary threshold — avoids flicker at the boundary.
   */
  mouth: {
    rawClosed: 0.035,
    rawOpen: 0.11,
    /** Exponent on the normalized aperture. >1 = needs a wider open. */
    curve: 1.15,
    /** Aperture above which we consider the mouth "meaningfully open". */
    activeAt: 0.18,
  },

  // ----------------------------------------------------------------- rope
  rope: {
    /** Number of chain segments. Anchor is node 0, hook is the last node. */
    segments: 12,
    /** Rest length of one segment when fully retracted, in canvas units. */
    segmentLengthMin: 9,
    /** Rest length of one segment at full mouth-open payout. */
    segmentLengthMax: 62,
    /** Rate the paid-out length chases the mouth target (per second). */
    payoutRate: 2.6,
    /** Rate the rope retracts when the mouth closes (per second). */
    retractRate: 1.9,
    /** Verlet constraint solver iterations per frame. 2-3 keeps it swingy. */
    solverIterations: 3,
    /**
     * Per-frame velocity retention. Lower = more damping.
     * Tuned so a sharp head movement settles in roughly one second.
     */
    swingDamping: 0.965,
    /** Extra damping applied to the hook node only, for readability. */
    hookDamping: 0.945,
    /** Mass multiplier on the hook node. Heavier = more momentum, more lag. */
    hookMass: 2.4,
    /** Gravity in canvas units per second squared. */
    gravity: 900,
    /** Gravity multiplier once a node is below the waterline (buoyancy). */
    underwaterGravityScale: 0.34,
    /** Velocity retention per frame for underwater nodes (drag). */
    underwaterDrag: 0.9,
    /** Line width of the rope stroke. */
    lineWidth: 3.5,
  },

  // --------------------------------------------------------------- forces
  /**
   * One unified force system. Currents, fish struggle, and any future hazard
   * all push through `applyForce` — nothing bypasses it.
   */
  forces: {
    /** Lateral current strength on mid-chain nodes. */
    currentStrength: 260,
    /** Speed of the current's sinusoidal drift, in Hz. */
    currentFrequency: 0.13,
    /** Second, faster current band for a less predictable sway. */
    currentFrequency2: 0.37,
    /** Fraction of the current applied at the hook (vs. the middle). */
    currentHookShare: 0.45,
    /** Peak force a struggling fish applies to the hook. */
    struggleStrength: 1500,
    /** How fast the struggle force changes direction, in Hz. */
    struggleFrequency: 1.7,
  },

  // ----------------------------------------------------------------- fish
  fish: {
    /** Base horizontal drift speed, canvas units per second. */
    speed: 62,
    /** Random +/- variation applied to speed. */
    speedJitter: 26,
    /** Seconds between spawn attempts. */
    spawnInterval: 1.15,
    /** Maximum fish alive at once. */
    maxAlive: 5,
    /** Depth band fish spawn in, as a fraction of the water column. */
    depthRange: [0.12, 0.82] as [number, number],
    /** Sprite draw width in canvas units. */
    width: 96,
    /** Distance at which a fish notices the hook and starts approaching. */
    noticeRadius: 190,
    /** Distance at which the fish begins its wind-up telegraph. */
    windUpRadius: 66,
    /** Seconds the fish pauses before the wind-up twitch begins. */
    pauseDuration: 0.35,
    /** Seconds the three-tick wind-up takes. Ticks fire at 0, 1/3, 2/3. */
    windUpDuration: 0.66,
    /** The forgiving catch window, in seconds, opening after the wind-up. */
    catchWindow: 0.3,
    /** Radius around the hook that counts as "on the hook" during the window. */
    catchRadius: 76,
    /** Seconds the struggle phase lasts before the fish is landed. */
    struggleDuration: 2.0,
    /** Seconds a spooked fish flees before resuming normal drift. */
    fleeDuration: 1.4,
  },

  // ---------------------------------------------------------------- water
  water: {
    /** Fraction of the screen height occupied by water, measured from bottom. */
    coverage: 0.5,
    /** Alpha of the translucent water layer drawn over the camera feed. */
    alpha: 0.75,
    /** Base amplitude of the undulating waterline, in canvas units. */
    waveAmplitude: 7,
    /** Base wavelength of the waterline sine, in canvas units. */
    waveLength: 260,
    /** Waterline scroll speed. */
    waveSpeed: 0.55,
    /** Peak extra amplitude of a reactive bump (fish pass / catch landed). */
    bumpAmplitude: 26,
    /** Seconds a reactive bump takes to decay. */
    bumpDecay: 0.85,
    /** Horizontal falloff of a bump, in canvas units. */
    bumpWidth: 130,
    /** Blur radius applied to fish so they read as "under" the surface. */
    underwaterBlur: 2.4,
  },

  // ---------------------------------------------------------------- audio
  audio: {
    masterGain: 0.55,
    /** Bass pulse period in seconds. */
    bassPeriod: 1.35,
    bassFrequency: 55,
    /** Base frequency of the first telegraph tick; each one rises. */
    tickBaseFrequency: 620,
    tickRiseRatio: 1.26,
  },

  // --------------------------------------------------------------- render
  /** Internal canvas resolution. The canvas is CSS-scaled to fit 9:16. */
  canvas: { width: 720, height: 1280 },
} as const;

export type Config = typeof CONFIG;
