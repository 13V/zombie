/**
 * Procedural sound engine — no audio files, no dependencies. Every effect is
 * synthesized live with the Web Audio API, so it ships with zero assets and
 * works offline. Sounds are intentionally short, punchy, and slightly
 * randomized so the constant gunfire/kills don't turn into a monotone buzz.
 *
 * Browsers block audio until the first user gesture, so `unlock()` is wired to
 * the first click/keypress and resumes the context.
 */
export class Audio {
  private ctx?: AudioContext;
  private master?: GainNode;
  private musicGain?: GainNode;
  private unlocked = false;
  private lastGunAt = 0;
  private lastGroanAt = 0;
  private musicOsc: OscillatorNode[] = [];
  private musicTimer?: number;
  enabled = true;

  /** Create the context lazily on first gesture (autoplay policy). */
  unlock() {
    if (this.unlocked) return;
    try {
      const Ctor = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.6;
      this.master.connect(this.ctx.destination);
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 0.0;
      this.musicGain.connect(this.master);
      this.unlocked = true;
    } catch {
      /* no audio available — game still runs silently */
    }
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (this.master) this.master.gain.value = on ? 0.6 : 0;
  }

  private get t(): number {
    return this.ctx!.currentTime;
  }

  private ok(): boolean {
    if (!this.enabled || !this.ctx || !this.master) return false;
    if (this.ctx.state === "suspended") this.ctx.resume();
    return true;
  }

  /** A single oscillator voice with an ADSR-ish gain envelope. */
  private blip(
    type: OscillatorType,
    freq: number,
    dur: number,
    gain: number,
    opts: { sweepTo?: number; delay?: number; dest?: AudioNode } = {},
  ) {
    const ctx = this.ctx!;
    const start = this.t + (opts.delay ?? 0);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (opts.sweepTo !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.sweepTo), start + dur);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(gain, start + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(g);
    g.connect(opts.dest ?? this.master!);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  }

  /** Short burst of filtered noise — used for gunfire/explosions/groans. */
  private noise(dur: number, gain: number, filterType: BiquadFilterType, freq: number, q = 1, sweepTo?: number) {
    const ctx = this.ctx!;
    const start = this.t;
    const frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = filterType;
    filt.frequency.setValueAtTime(freq, start);
    filt.Q.value = q;
    if (sweepTo !== undefined) filt.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), start + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, start);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    src.connect(filt);
    filt.connect(g);
    g.connect(this.master!);
    src.start(start);
    src.stop(start + dur + 0.02);
  }

  // ---- gameplay sounds ----

  /** Weapon shot. `tone` shifts timbre for different guns (0..1). */
  shoot(tone = 0.5) {
    if (!this.ok()) return;
    // rate-limit so auto weapons don't spawn dozens of nodes per frame
    if (this.t - this.lastGunAt < 0.03) return;
    this.lastGunAt = this.t;
    const base = 220 + tone * 180;
    this.noise(0.09, 0.35, "highpass", 700 + tone * 600, 0.7);
    this.blip("square", base * (0.95 + Math.random() * 0.1), 0.07, 0.12, { sweepTo: base * 0.4 });
  }

  /** Confirms a bullet connected — crisp tick. `crit` for headshots. */
  hit(crit = false) {
    if (!this.ok()) return;
    this.blip("triangle", crit ? 1400 : 900, 0.05, crit ? 0.22 : 0.14, { sweepTo: crit ? 700 : 500 });
  }

  /** Zombie dies. */
  kill() {
    if (!this.ok()) return;
    this.noise(0.18, 0.25, "lowpass", 600, 1, 120);
    this.blip("sawtooth", 160, 0.18, 0.12, { sweepTo: 60 });
  }

  /** Ambient zombie groan, rate-limited + pitch-varied. */
  groan() {
    if (!this.ok()) return;
    if (this.t - this.lastGroanAt < 0.4) return;
    this.lastGroanAt = this.t;
    const f = 90 + Math.random() * 70;
    this.blip("sawtooth", f, 0.5, 0.06, { sweepTo: f * 0.7 });
    this.noise(0.4, 0.04, "bandpass", 300, 4);
  }

  /** Player takes damage. */
  hurt() {
    if (!this.ok()) return;
    this.blip("sawtooth", 200, 0.18, 0.2, { sweepTo: 80 });
    this.noise(0.12, 0.12, "lowpass", 400);
  }

  /** Big explosion (bomber/grenade). */
  boom() {
    if (!this.ok()) return;
    this.noise(0.5, 0.5, "lowpass", 800, 1, 60);
    this.blip("sine", 90, 0.4, 0.3, { sweepTo: 30 });
  }

  /** Reward jingle for pickups / power-ups (rising arpeggio). */
  powerup() {
    if (!this.ok()) return;
    const notes = [523, 659, 784, 1047];
    notes.forEach((n, i) => this.blip("square", n, 0.12, 0.16, { delay: i * 0.06 }));
  }

  /** Buy / interaction confirm. */
  buy() {
    if (!this.ok()) return;
    this.blip("square", 660, 0.08, 0.16);
    this.blip("square", 990, 0.1, 0.14, { delay: 0.07 });
  }

  /** Denied (can't afford). */
  deny() {
    if (!this.ok()) return;
    this.blip("square", 220, 0.12, 0.16, { sweepTo: 160 });
  }

  /** New round sting (descending then resolving). */
  roundStart() {
    if (!this.ok()) return;
    const notes = [392, 523, 659];
    notes.forEach((n, i) => this.blip("triangle", n, 0.3, 0.18, { delay: i * 0.12 }));
    this.noise(0.6, 0.06, "bandpass", 200, 2);
  }

  /** Revive complete / clutch. */
  revive() {
    if (!this.ok()) return;
    const notes = [330, 440, 554, 659];
    notes.forEach((n, i) => this.blip("sine", n, 0.2, 0.16, { delay: i * 0.08 }));
  }

  /** UI click. */
  ui() {
    if (!this.ok()) return;
    this.blip("square", 880, 0.05, 0.1);
  }

  // ---- ambient music: a slow two-oscillator drone that intensifies by round ----
  startMusic(intensity = 0) {
    if (!this.ok() || !this.musicGain) return;
    this.stopMusic();
    const ctx = this.ctx!;
    const roots = [55, 82.4]; // A1 + E2 drone
    for (const r of roots) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = r;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 200 + intensity * 600;
      osc.connect(lp);
      lp.connect(this.musicGain);
      osc.start();
      this.musicOsc.push(osc);
    }
    // gentle fade-in
    this.musicGain.gain.cancelScheduledValues(this.t);
    this.musicGain.gain.setValueAtTime(0.0001, this.t);
    this.musicGain.gain.exponentialRampToValueAtTime(0.08 + intensity * 0.05, this.t + 2);
  }

  /** Nudge the drone's loudness/brightness as rounds escalate. */
  setIntensity(intensity: number) {
    if (!this.musicGain) return;
    this.musicGain.gain.setTargetAtTime(0.08 + Math.min(1, intensity) * 0.07, this.t, 1.5);
  }

  stopMusic() {
    if (this.musicTimer) clearInterval(this.musicTimer);
    for (const o of this.musicOsc) {
      try {
        o.stop();
      } catch {
        /* already stopped */
      }
    }
    this.musicOsc = [];
    if (this.musicGain) this.musicGain.gain.setTargetAtTime(0.0001, this.t, 0.4);
  }
}
