/**
 * Retro sound effects synthesised with WebAudio: no audio files to download.
 * Sounds are positioned in stereo relative to the camera and attenuated with
 * distance. Each effect type is rate-limited so big fights stay listenable.
 */
import { VIEW_WIDTH, WORLD_SIZE } from '../shared/constants.js';
import { clamp, wrapDelta } from '../shared/math.js';

const HEARING_RANGE = VIEW_WIDTH * 0.75;

export class Sound {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noise = null;
    this.muted = false;
    try {
      this.muted = localStorage.getItem('blasteroid.muted') === '1';
    } catch {
      // storage unavailable (private mode); keep default
    }
    this.lastPlayed = new Map();
    this.listenerX = 0;
    this.listenerY = 0;
    this.thrust = null;
  }

  /** Must be called from a user gesture (browsers block audio until then). */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    this.ctx = new AudioCtx();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(this.ctx.destination);
    const length = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.5;
    try {
      localStorage.setItem('blasteroid.muted', this.muted ? '1' : '0');
    } catch {
      // ignore
    }
    return this.muted;
  }

  setListener(x, y) {
    this.listenerX = x;
    this.listenerY = y;
  }

  /** Output node for a sound at world position (x, y), or null if inaudible or throttled. */
  output(key, minGapMs, x, y, volume) {
    const ctx = this.ctx;
    if (!ctx || this.muted || ctx.state !== 'running') return null;
    const now = performance.now();
    if (now - (this.lastPlayed.get(key) ?? 0) < minGapMs) return null;
    let gainValue = volume;
    let pan = 0;
    if (x !== undefined) {
      const dx = wrapDelta(x - this.listenerX, WORLD_SIZE);
      const dy = wrapDelta(y - this.listenerY, WORLD_SIZE);
      const dist = Math.hypot(dx, dy);
      if (dist > HEARING_RANGE) return null;
      gainValue *= 1 - dist / HEARING_RANGE;
      pan = clamp(dx / (VIEW_WIDTH / 2), -1, 1);
    }
    this.lastPlayed.set(key, now);
    const gain = ctx.createGain();
    gain.gain.value = gainValue;
    if (pan !== 0 && ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      gain.connect(panner).connect(this.master);
    } else {
      gain.connect(this.master);
    }
    return gain;
  }

  tone(out, type, from, to, duration, delay = 0) {
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + duration);
    env.gain.setValueAtTime(1, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.connect(env).connect(out);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  burst(out, duration, fromHz, toHz, type = 'lowpass') {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(fromHz, t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(20, toHz), t + duration);
    const env = ctx.createGain();
    env.gain.setValueAtTime(1, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src.connect(filter).connect(env).connect(out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + duration + 0.02);
  }

  /* Effects ------------------------------------------------------------------- */

  fire(heavy, x, y, mine) {
    const out = this.output(mine ? 'fire-own' : 'fire', mine ? 40 : 70, mine ? undefined : x, y, mine ? 0.16 : 0.08);
    if (!out) return;
    if (heavy) this.tone(out, 'sawtooth', 220, 55, 0.22);
    else this.tone(out, 'square', 1100, 180, 0.09);
  }

  explosion(size, x, y) {
    const out = this.output(`boom${size > 1.5 ? 'L' : 'S'}`, 45, x, y, 0.35 + 0.25 * Math.min(size, 2));
    if (!out) return;
    this.burst(out, 0.25 + 0.35 * Math.min(size, 2), 2600, 60);
  }

  /** Our ship touching down on or slamming into a planet. */
  thud(strength) {
    const out = this.output('thud', 120, undefined, undefined, 0.15 + 0.25 * Math.min(strength, 1));
    if (out) this.burst(out, 0.12 + 0.2 * Math.min(strength, 1), 500, 50);
  }

  hit(x, y) {
    const out = this.output('hit', 50, x, y, 0.12);
    if (out) this.burst(out, 0.06, 6000, 1500, 'highpass');
  }

  hitConfirm() {
    const out = this.output('confirm', 60, undefined, undefined, 0.07);
    if (out) this.tone(out, 'triangle', 1800, 1400, 0.05);
  }

  hurt() {
    const out = this.output('hurt', 90, undefined, undefined, 0.3);
    if (!out) return;
    this.burst(out, 0.18, 900, 120);
    this.tone(out, 'square', 140, 60, 0.15);
  }

  pickup(powerup) {
    const out = this.output(powerup ? 'powerup' : 'pickup', 50, undefined, undefined, 0.12);
    if (!out) return;
    if (powerup) {
      this.tone(out, 'square', 523, 523, 0.08);
      this.tone(out, 'square', 784, 784, 0.08, 0.08);
      this.tone(out, 'square', 1046, 1046, 0.14, 0.16);
    } else {
      this.tone(out, 'sine', 880 + Math.random() * 200, 1500, 0.07);
    }
  }

  levelUp() {
    const out = this.output('level', 300, undefined, undefined, 0.15);
    if (!out) return;
    [523, 659, 784, 1046].forEach((f, i) => this.tone(out, 'square', f, f, 0.1, i * 0.07));
  }

  alarm() {
    const out = this.output('alarm', 2000, undefined, undefined, 0.18);
    if (!out) return;
    for (let i = 0; i < 3; i++) this.tone(out, 'sawtooth', 440, 880, 0.25, i * 0.3);
  }

  /** Continuous engine rumble while thrusting. */
  setThrust(on, boost) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    if (!this.thrust) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 400;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(this.master);
      src.start();
      this.thrust = { gain, filter };
    }
    const target = on && !this.muted ? (boost ? 0.22 : 0.12) : 0;
    this.thrust.gain.gain.setTargetAtTime(target, ctx.currentTime, 0.05);
    this.thrust.filter.frequency.setTargetAtTime(boost ? 900 : 400, ctx.currentTime, 0.1);
  }
}
