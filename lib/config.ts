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
   * The rope hangs off the player's actual nose. The anchor is therefore NOT
   * remapped or amplified — it is the nose landmark pushed through the exact
   * same cover-fit + mirror transform used to draw the camera, so the line
   * always leaves the screen where the nose actually is. Any gain here would
   * visibly detach the rope from the face, which is the whole gag.
   */
  anchor: {
    /** Canvas units of margin keeping the anchor on-screen if tracking drifts. */
    screenMargin: 12,
    /**
     * Canvas units to drop the anchor below the nose landmark, so the line
     * reads as hanging off the tip rather than sprouting from the middle of it.
     */
    noseOffset: 10,
  },

  /**
   * Touch-mode only. With no face to pin to, the anchor rides a band near the
   * top of the screen and the lower part of the drag pays out line.
   */
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
    /**
     * Rest length of one segment when fully retracted, in canvas units.
     * Times `segments`, this is how far below the nose the hook sits with the
     * mouth shut — and therefore how far the head has to lift to bring a catch
     * up to the surface. Raising it makes landing a fish harder.
     */
    segmentLengthMin: 7,
    /** Rest length of one segment at full mouth-open payout. */
    segmentLengthMax: 62,
    /**
     * Rate the paid-out length chases the mouth target (per second).
     * 1.0 would mean a full drop takes exactly one second. Slow enough that
     * sinking the hook is a committed act you can watch happen.
     */
    payoutRate: 1.45,
    /**
     * Rate the rope retracts when the mouth closes (per second).
     * Half the payout rate: line drops faster than it comes back, so hauling a
     * fish up is the slow, deliberate part of the fight.
     */
    retractRate: 0.7,
    /** Verlet constraint solver iterations per frame. 2-3 keeps it swingy. */
    solverIterations: 3,
    /**
     * Per-frame velocity retention. Lower = more damping.
     * Kept high — the hook should coast and whip, not wade.
     */
    swingDamping: 0.99,
    /** Extra damping applied to the hook node only, for readability. */
    hookDamping: 0.982,
    /** Mass multiplier on the hook node. Heavier = more momentum, more lag. */
    hookMass: 2.4,
    /** Gravity in canvas units per second squared. */
    gravity: 900,
    /** Gravity multiplier once a node is below the waterline (buoyancy). */
    underwaterGravityScale: 0.5,
    /**
     * Velocity retention per frame for underwater nodes (drag).
     * This is the "how thick is the water" dial. It compounds every frame, so
     * small changes are enormous: 0.90 kills 99.8% of the hook's speed inside a
     * second and reads as syrup. Keep it close to the surface damping.
     */
    underwaterDrag: 0.985,
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

    /** Chance a spawned fish is the rare tier. */
    rareChance: 0.18,
    /** Rare fish draw wider than common — size is part of the rarity read. */
    rareScale: 1.34,
    /** Rare fish swim slower, so they feel weightier and more catchable. */
    rareSpeedScale: 0.72,
    /** Rare fish pull harder during the struggle. */
    rareStruggleScale: 1.45,
    /** Rare fish spawn deeper — you have to commit to reach them. */
    rareDepthRange: [0.45, 0.82] as [number, number],
    /**
     * Distance at which a fish notices the hook and starts approaching.
     * Deliberately tight: a fish should only commit once the hook has come to
     * it, not cross the screen to meet the player. Speed of the approach is
     * `approachSpeedMul` — that is the dial for eagerness, not this one.
     */
    noticeRadius: 165,
    /** Multiplier on the fish's own speed while it is homing on the hook. */
    approachSpeedMul: 2.7,
    /** Distance at which the fish begins its wind-up telegraph. */
    windUpRadius: 74,
    /** Seconds the fish pauses before the wind-up twitch begins. */
    pauseDuration: 0.22,
    /** Seconds the three-tick wind-up takes. Ticks fire at 0, 1/3, 2/3. */
    windUpDuration: 0.42,
    /** The forgiving catch window, in seconds, opening after the wind-up. */
    catchWindow: 0.45,
    /** Radius around the hook that counts as "on the hook" during the window. */
    catchRadius: 84,
    /** Canvas units below the surface a free fish is never allowed to rise past. */
    surfaceKeepOut: 26,
    /** Seconds a spooked fish flees before resuming normal drift. */
    fleeDuration: 1.4,

    // ------------------------------------------------------------ the fight
    /**
     * A hooked fish is NOT earned on a timer. It is earned by hauling it to the
     * surface and throwing it clear — see the `fling` block below.
     */
    /** Seconds the fish fights before it throws the hook and escapes. */
    escapeAfter: 8.0,
    /** Steady downward pull a hooked fish adds at the hook. */
    fishWeight: 900,
    /** Seconds of grace before the fish's weight and thrashing ramp in fully. */
    fightRampIn: 0.45,
  },

  // ---------------------------------------------------------------- fling
  /**
   * A fish is not earned by holding it above the water — it is earned by
   * whipping your head up and throwing it into the air. The check is on the
   * ANCHOR's velocity (the player's head), never the hook's: reeling the line
   * in yanks the hook upward faster than any head-flick, and a thrashing fish
   * whips it around on its own. Only the nose moves because the player moved it.
   */
  fling: {
    /**
     * Upward head speed, in canvas units/sec, needed to throw the fish.
     * Sits in the gap between a lift and a throw: simulated against the real
     * rope, a leisurely half-second head-raise peaks around 740 and a genuine
     * snap clears 1000. Lower this if real players find the throw stubborn.
     */
    speed: 800,
    /**
     * How much the upward motion must dominate the sideways motion.
     * 1.0 admits anything within 45 degrees of straight up.
     */
    coneRatio: 1.0,
    /** The hook may still be this far BELOW the surface when the fling fires. */
    depthAllowance: 46,
    /** Fraction of the head's velocity handed to the flying fish. */
    transfer: 1.1,
    /** Extra upward kick on release, so a fling always reads as an arc. */
    kick: 280,
    /** Gravity on a fish in flight, canvas units per second squared. */
    gravity: 1500,
    /** Tumble rate of a flying fish, radians per second. */
    spin: 8,
    /**
     * Launch speed ceilings, canvas units/sec.
     *
     * Without these a real head-snap throws the fish thousands of pixels above
     * a 1280px screen on a 3-4 second round trip: it leaves frame, and by the
     * time it falls back it has been culled. Clamping keeps the apex just
     * inside the top of the screen and the round trip near 1.7s, which is what
     * makes the fish catchable at all.
     */
    maxLaunchUp: 1300,
    /**
     * Sideways ceiling. At 340 any lateral component put the fish out of reach
     * entirely — and no real head-snap is perfectly vertical. This caps drift
     * near 258px, which a player can cover by leaning to intercept.
     */
    maxLaunchSide: 150,
    /** Seconds a flung fish stays alive before it is culled. */
    lifetime: 3.6,
    /** Seconds of fade-out at the END of that lifetime, never before. */
    fadeOut: 0.5,

    // ------------------------------------------------------ the mouth catch
    /**
     * A thrown fish can be caught on the way down — in your mouth.
     *
     * Pure upside: the throw has already scored, so a gulp is a bonus and a
     * miss costs nothing. The tension is built in rather than bolted on,
     * because opening wide to catch also pays the rope out and sinks your hook.
     */
    gulp: {
      /** Radius around the mouth centre that swallows a falling fish. */
      radius: 130,
      /** Minimum mouth aperture (0..1) for the mouth to count as open. */
      aperture: 0.45,
      /** Extra points a gulp is worth, on top of the fish already landed. */
      points: 1,
      /**
       * Only a DESCENDING fish can be gulped. Without this the fish is eaten on
       * the way up, a pixel after it leaves the hook, and the arc never happens.
       */
      minFallSpeed: 40,
    },
  },

  // -------------------------------------------------------------- capture
  /**
   * The photo roll.
   *
   * Every frame is scored and only the best few survive. Event triggers were
   * tried first and produced a flood of near-identical portraits — a face above
   * a fully paid-out line — that buried the genuinely absurd frames.
   */
  capture: {
    /**
     * Hard cap, catches included. Four prints, the best of the run.
     * Because this is absolute, a catch is not exempt from scoring: everything
     * competes on one ranking and a landed fish earns its slot via `catchBonus`.
     */
    maxShots: 4,
    /** Fraction of play resolution stored frames are shot at. */
    scale: 0.5,

    /**
     * What makes a frame funny, each scored 0..1.
     *
     * `hookNear` is load-bearing: a hook dangling beside someone's nose is the
     * entire joke, while the identical face over a paid-out line is a portrait
     * above an empty rectangle. `throwUp` is upward head speed specifically —
     * mid-throw is the shot worth keeping.
     */
    weight: { mouth: 1.0, hookNear: 1.15, tug: 0.7, throwUp: 1.3 },
    /** Added to a frame taken at the instant a fish was landed. */
    catchBonus: 1.6,
    /**
     * Added to a frame taken at the instant a fish is gulped. Larger than
     * `catchBonus` because a fish vanishing into an open mouth is the single
     * best frame the game can produce, and it should never lose a slot.
     */
    gulpBonus: 3.2,
    /** Distance from the face, in canvas units, at which `hookNear` hits zero. */
    hookNearRadius: 300,
    /**
     * Hard gate: `hookNear` must reach this before a frame is even considered.
     * Not just another weighted term — as one, mouth+tug qualified on their own
     * and that is exactly the dull framing. The hook beside the face is the
     * PREMISE; mouth and throw are the punchline. No premise, no photo.
     */
    minHookNear: 0.3,
    /** Head speed, canvas units/sec, scoring a full 1.0 on `tug`. */
    tugSpeed: 620,
    /**
     * Minimum total score to keep a frame. Above any single weight, so one
     * maxed-out signal is never enough: a frame needs two things at once.
     */
    minScore: 1.15,
    /** Seconds between shots, so one funny moment is one photo, not a burst. */
    minGap: 0.5,
    /** JPEG quality for stored frames. */
    quality: 0.82,
  },

  // ------------------------------------------------------------ animation
  /**
   * Runtime sprite deformation. The fish sprite is drawn as vertical slices,
   * each offset by a travelling sine wave — head stiff, tail whipping. This is
   * the same math the exported sprite sheets were baked from, but run live so
   * it is smooth rather than locked to a frame count.
   */
  deform: {
    /**
     * Number of vertical slices per fish. Each slice is one drawImage, so this
     * multiplies by the live fish count every frame — 10 is the point where
     * the curve still reads smooth but the cost stays flat.
     */
    slices: 10,
    /** Exponent on the head→tail stiffness ramp. Higher = stiffer head. */
    stiffness: 1.6,

    swim: {
      /** Tail displacement as a fraction of sprite height. */
      tailAmp: 0.055,
      /** Wavelength of the travelling wave along the body, 0..1 of length. */
      waveLength: 0.9,
      /** Cycles per second. */
      hz: 1.15,
      /** Peak body rotation in radians. */
      rot: 0.05,
    },

    hooked: {
      tailAmp: 0.13,
      waveLength: 0.55,
      hz: 2.4,
      rot: 0.35,
      /** Body curl amplitude as a fraction of sprite height. */
      archAmp: 0.075,
    },
  },

  // ----------------------------------------------------------- ink palette
  /** Splatoon-ish ink palette. Every colour in the game comes from here. */
  ink: {
    /** Sky / above-water backdrop when there is no camera. */
    voidTop: "#1b0f38",
    voidBottom: "#0d0722",
    /** Water body, surface to floor. */
    waterTop: "#3d1a6b",
    waterMid: "#2a1152",
    waterDeep: "#150a33",
    /** The crisp neon surface line. */
    surface: "#8de8ff",
    /** Caustic bands under the surface. */
    caustic: "#a06bff",
    /** Rope. */
    rope: "#fff3dc",
    ropeOutline: "#120a20",
    /** Rarity glow around a rare fish. */
    rareGlow: "#ffd23d",
    /** Catch flash / ink splat. */
    splat: "#ff2d9b",
    /** Tension shimmer while a fish fights. */
    tension: "#8de8ff",
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
    /**
     * Opacity of submerged fish. Deliberately NOT a canvas blur — `ctx.filter`
     * is catastrophically slow on mobile Safari at this canvas size.
     */
    underwaterAlpha: 0.95,
    /**
     * Submerged fish are drawn a second time on top of the water layer at this
     * alpha. The 0.75 water layer otherwise drags them 75% of the way to the
     * water colour and a magenta fish on purple water stops reading. This is
     * the standard fog-blend trick: depth is preserved, contrast comes back.
     */
    fishRestoreAlpha: 0.36,
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
