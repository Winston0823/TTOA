import { CONFIG } from "./config";

/**
 * All sound is synthesized with oscillators — no asset files.
 * One AudioContext, created lazily and resumed on the start tap (iOS requires
 * the resume to happen inside a user gesture or nothing will ever play).
 */
export class GameAudio {
  ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private bassTimer: number | null = null;
  private spoolOsc: OscillatorNode | null = null;
  private spoolGain: GainNode | null = null;
  private spoolFilter: BiquadFilterNode | null = null;
  private started = false;

  /** Must be called from inside a user-gesture handler. */
  async start() {
    if (this.started) {
      if (this.ctx?.state === "suspended") await this.ctx.resume();
      return;
    }
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    this.ctx = new Ctor();
    // iOS Safari: this must run inside the gesture or the context stays muted.
    await this.ctx.resume();

    this.master = this.ctx.createGain();
    this.master.gain.value = CONFIG.audio.masterGain;
    this.master.connect(this.ctx.destination);

    this.started = true;
  }

  stop() {
    this.stopBass();
    this.stopSpool();
  }

  // ------------------------------------------------------------------ bass
  /** A slow low pulse that sits underneath everything. */
  startBass() {
    if (!this.ctx || !this.master || this.bassTimer !== null) return;
    const pulse = () => {
      if (!this.ctx || !this.master) return;
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      const filter = this.ctx.createBiquadFilter();

      osc.type = "sine";
      osc.frequency.setValueAtTime(CONFIG.audio.bassFrequency, t);
      osc.frequency.exponentialRampToValueAtTime(CONFIG.audio.bassFrequency * 0.72, t + 0.6);

      filter.type = "lowpass";
      filter.frequency.value = 220;

      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.5, t + 0.08);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);

      osc.connect(filter).connect(gain).connect(this.master);
      osc.start(t);
      osc.stop(t + 0.9);
    };
    pulse();
    this.bassTimer = window.setInterval(pulse, CONFIG.audio.bassPeriod * 1000);
  }

  stopBass() {
    if (this.bassTimer !== null) {
      clearInterval(this.bassTimer);
      this.bassTimer = null;
    }
  }

  // ------------------------------------------------------------ bite ticks
  /**
   * One of the three rising ticks that telegraph a bite.
   * `n` is 0, 1 or 2 — each is a step higher than the last.
   */
  tick(n: number) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const freq =
      CONFIG.audio.tickBaseFrequency * Math.pow(CONFIG.audio.tickRiseRatio, n);

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(freq * 1.04, t + 0.07);

    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.34, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);

    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  // ---------------------------------------------------------------- stings
  /** Bright rising arpeggio on a successful catch. */
  catchSting() {
    if (!this.ctx || !this.master) return;
    const t0 = this.ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      const t = t0 + i * 0.055;
      const osc = this.ctx!.createOscillator();
      const gain = this.ctx!.createGain();
      osc.type = "square";
      osc.frequency.setValueAtTime(f, t);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.2, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      osc.connect(gain).connect(this.master!);
      osc.start(t);
      osc.stop(t + 0.32);
    });
  }

  /** Dull, damped thunk when a bite is missed. */
  thunk() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();

    osc.type = "sine";
    osc.frequency.setValueAtTime(180, t);
    osc.frequency.exponentialRampToValueAtTime(70, t + 0.22);

    filter.type = "lowpass";
    filter.frequency.value = 400;

    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.34, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);

    osc.connect(filter).connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.3);
  }

  // ----------------------------------------------------------- rope spool
  /**
   * Continuous filtered-noise-ish tone while the rope pays out.
   * `amount` is 0..1 — drives both volume and filter cutoff, so the sound
   * tracks how fast the rope is actually moving.
   */
  setSpool(amount: number) {
    if (!this.ctx || !this.master) return;
    const a = Math.max(0, Math.min(1, amount));

    if (a < 0.02) {
      this.stopSpool();
      return;
    }

    if (!this.spoolOsc) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      const filter = this.ctx.createBiquadFilter();
      osc.type = "sawtooth";
      osc.frequency.value = 90;
      filter.type = "bandpass";
      filter.Q.value = 3.2;
      filter.frequency.value = 700;
      gain.gain.value = 0;
      osc.connect(filter).connect(gain).connect(this.master);
      osc.start();
      this.spoolOsc = osc;
      this.spoolGain = gain;
      this.spoolFilter = filter;
    }

    const t = this.ctx.currentTime;
    this.spoolGain!.gain.setTargetAtTime(0.075 * a, t, 0.04);
    this.spoolFilter!.frequency.setTargetAtTime(520 + 900 * a, t, 0.05);
    this.spoolOsc!.frequency.setTargetAtTime(70 + 60 * a, t, 0.05);
  }

  stopSpool() {
    if (!this.spoolOsc || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.spoolGain?.gain.setTargetAtTime(0, t, 0.03);
    const osc = this.spoolOsc;
    this.spoolOsc = null;
    this.spoolGain = null;
    this.spoolFilter = null;
    try {
      osc.stop(t + 0.2);
    } catch {
      /* already stopped */
    }
  }
}
