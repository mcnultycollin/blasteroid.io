/**
 * Cosmetic effects: vector debris particles, expanding shockwave rings,
 * floating text and screen shake. Particles live in fixed-size typed arrays
 * (no per-particle allocation) and are drawn in a few batched paths, one per
 * palette colour.
 */
import { TAU, wrap, wrapDelta } from '../shared/math.js';
import { WORLD_SIZE } from '../shared/constants.js';

const CAPACITY = 4096;
const MAX_RINGS = 32;

/** Shared palette; particles reference colours by index so drawing can batch by colour. */
export const PALETTE = [
  '#ffffff', // 0 white
  '#ffd166', // 1 gold
  '#ff8c42', // 2 orange
  '#ff4d4d', // 3 red
  '#9aa5b1', // 4 rock grey
  '#5cf2ff', // 5 cyan
  '#7dff6a', // 6 green
  '#ff5cf2', // 7 magenta
  '#b48cff', // 8 violet
];
export const Color = Object.freeze({ WHITE: 0, GOLD: 1, ORANGE: 2, RED: 3, ROCK: 4, CYAN: 5, GREEN: 6, MAGENTA: 7, VIOLET: 8 });
const HUE_BASE = PALETTE.length;
for (let h = 0; h < 360; h += 30) PALETTE.push(`hsl(${h} 90% 65%)`);

/** Palette index closest to a player hue. */
export function hueColor(hue) {
  return HUE_BASE + (Math.round(hue / 30) % 12);
}

export class Effects {
  constructor() {
    this.count = 0;
    this.x = new Float32Array(CAPACITY);
    this.y = new Float32Array(CAPACITY);
    this.vx = new Float32Array(CAPACITY);
    this.vy = new Float32Array(CAPACITY);
    this.life = new Float32Array(CAPACITY);
    this.maxLife = new Float32Array(CAPACITY);
    this.length = new Float32Array(CAPACITY); // streak length factor; 0 draws a dot
    this.drag = new Float32Array(CAPACITY);
    this.color = new Uint8Array(CAPACITY);
    this.texts = [];
    this.rings = []; // { x, y, r0, r1, angle, spread, life, maxLife, color, width }
    this.shake = 0;
    this.buckets = PALETTE.map(() => []);
  }

  clear() {
    this.count = 0;
    this.texts.length = 0;
    this.rings.length = 0;
    this.shake = 0;
  }

  /**
   * A ring (or an arc of `spread` radians either side of `angle`) whose
   * radius runs from r0 to r1 over `life` seconds while it fades out.
   */
  ring(x, y, r0, r1, life, color, angle = 0, spread = Math.PI, width = 3) {
    if (this.rings.length >= MAX_RINGS) this.rings.shift();
    this.rings.push({ x, y, r0, r1, angle, spread, life, maxLife: life, color, width });
  }

  /** The kinetic blast: a shockwave arc and a spray of streaks filling its cone. */
  blast(x, y, angle, range, halfAngle, vx = 0, vy = 0) {
    this.ring(x, y, 18, range, 0.32, Color.CYAN, angle, halfAngle, 5);
    this.ring(x, y, 10, range * 0.7, 0.45, Color.WHITE, angle, halfAngle * 0.8, 2);
    for (let i = 0; i < 26; i++) {
      const a = angle + (Math.random() * 2 - 1) * halfAngle;
      const s = range * (1.6 + Math.random() * 1.6);
      this.spawn(x, y, vx + Math.cos(a) * s, vy + Math.sin(a) * s, 0.2 + Math.random() * 0.15, i % 3 ? Color.CYAN : Color.WHITE, 0.03, 5);
    }
  }

  /** Flames licking off a ship touching the star. */
  burn(x, y) {
    for (let i = 0; i < 3; i++) {
      const a = Math.random() * TAU;
      const s = 60 + Math.random() * 140;
      this.spawn(x, y, Math.cos(a) * s, Math.sin(a) * s, 0.25 + Math.random() * 0.25, i === 0 ? Color.GOLD : i === 1 ? Color.ORANGE : Color.RED, 0.04, 2);
    }
  }

  spawn(x, y, vx, vy, life, color, length, drag) {
    let i = this.count;
    if (i === CAPACITY) i = Math.floor(Math.random() * CAPACITY); // recycle a random particle
    else this.count++;
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.color[i] = color;
    this.length[i] = length;
    this.drag[i] = drag;
  }

  /** Radial burst of streaks. */
  burst(x, y, count, speed, color, life = 0.7, length = 0.05) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const s = speed * (0.3 + Math.random() * 0.7);
      this.spawn(x, y, Math.cos(a) * s, Math.sin(a) * s, life * (0.5 + Math.random() * 0.5), color, length, 1.5);
    }
  }

  /** Big multi-colour explosion, e.g. a ship. */
  explosion(x, y, scale, color) {
    this.burst(x, y, Math.round(26 * scale), 380 * scale, color, 1.1, 0.06);
    this.burst(x, y, Math.round(18 * scale), 260 * scale, Color.ORANGE, 0.9, 0.05);
    this.burst(x, y, Math.round(14 * scale), 160 * scale, Color.WHITE, 0.6, 0);
  }

  /** Small impact spark. */
  spark(x, y, color = Color.WHITE) {
    this.burst(x, y, 6, 220, color, 0.25, 0.03);
  }

  /** Engine exhaust from (x, y) blowing towards `angle` (opposite the push). */
  exhaust(x, y, angle, vx, vy, boost, strength = 1) {
    const a = angle + (Math.random() - 0.5) * 0.5;
    const s = (boost ? 260 : 150) * strength * (0.6 + Math.random() * 0.4);
    this.spawn(x, y, vx * 0.4 + Math.cos(a) * s, vy * 0.4 + Math.sin(a) * s, boost ? 0.35 : 0.22 * strength, boost ? Color.CYAN : Color.ORANGE, 0, 2);
  }

  /** Particles pulled from (x, y) towards (tx, ty), used for pickups being collected. */
  converge(x, y, tx, ty, color) {
    const dx = wrapDelta(tx - x, WORLD_SIZE);
    const dy = wrapDelta(ty - y, WORLD_SIZE);
    for (let i = 0; i < 6; i++) {
      this.spawn(x, y, dx * 5 + (Math.random() - 0.5) * 120, dy * 5 + (Math.random() - 0.5) * 120, 0.18, color, 0.02, 0);
    }
  }

  text(x, y, label, color, size = 16) {
    if (this.texts.length > 40) this.texts.shift();
    this.texts.push({ x, y, label, color, size, life: 1.1 });
  }

  addShake(amount) {
    this.shake = Math.min(18, this.shake + amount);
  }

  update(dt) {
    let i = 0;
    while (i < this.count) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        // swap-remove
        const last = --this.count;
        this.x[i] = this.x[last];
        this.y[i] = this.y[last];
        this.vx[i] = this.vx[last];
        this.vy[i] = this.vy[last];
        this.life[i] = this.life[last];
        this.maxLife[i] = this.maxLife[last];
        this.color[i] = this.color[last];
        this.length[i] = this.length[last];
        this.drag[i] = this.drag[last];
        continue;
      }
      const k = Math.exp(-this.drag[i] * dt);
      this.vx[i] *= k;
      this.vy[i] *= k;
      this.x[i] = wrap(this.x[i] + this.vx[i] * dt, WORLD_SIZE);
      this.y[i] = wrap(this.y[i] + this.vy[i] * dt, WORLD_SIZE);
      i++;
    }
    for (let t = this.texts.length - 1; t >= 0; t--) {
      const text = this.texts[t];
      text.life -= dt;
      text.y -= 40 * dt;
      if (text.life <= 0) this.texts.splice(t, 1);
    }
    for (let r = this.rings.length - 1; r >= 0; r--) {
      if ((this.rings[r].life -= dt) <= 0) this.rings.splice(r, 1);
    }
    this.shake *= Math.exp(-dt * 9);
    if (this.shake < 0.05) this.shake = 0;
  }

  /** Draws particles in world space; the context is already transformed to world units around the camera. */
  draw(ctx, camX, camY, halfW, halfH) {
    const buckets = this.buckets;
    for (const b of buckets) b.length = 0;
    for (let i = 0; i < this.count; i++) {
      const dx = wrapDelta(this.x[i] - camX, WORLD_SIZE);
      const dy = wrapDelta(this.y[i] - camY, WORLD_SIZE);
      if (dx < -halfW || dx > halfW || dy < -halfH || dy > halfH) continue;
      buckets[this.color[i]].push(i);
    }
    ctx.lineCap = 'round';
    for (let c = 0; c < buckets.length; c++) {
      const list = buckets[c];
      if (list.length === 0) continue;
      ctx.strokeStyle = PALETTE[c];
      ctx.fillStyle = PALETTE[c];
      // Two alpha bands keep fading cheap while still batching.
      for (let band = 0; band < 2; band++) {
        ctx.globalAlpha = band === 0 ? 0.45 : 1;
        ctx.beginPath();
        for (const i of list) {
          const young = this.life[i] > this.maxLife[i] * 0.45;
          if (young !== (band === 1)) continue;
          const x = wrapDelta(this.x[i] - camX, WORLD_SIZE);
          const y = wrapDelta(this.y[i] - camY, WORLD_SIZE);
          const len = this.length[i];
          if (len > 0) {
            ctx.moveTo(x, y);
            ctx.lineTo(x - this.vx[i] * len, y - this.vy[i] * len);
          } else {
            ctx.rect(x - 1.5, y - 1.5, 3, 3);
          }
        }
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    for (const ring of this.rings) {
      const x = wrapDelta(ring.x - camX, WORLD_SIZE);
      const y = wrapDelta(ring.y - camY, WORLD_SIZE);
      if (x < -halfW - ring.r1 || x > halfW + ring.r1 || y < -halfH - ring.r1 || y > halfH + ring.r1) continue;
      const t = 1 - ring.life / ring.maxLife;
      const eased = 1 - (1 - t) * (1 - t);
      ctx.beginPath();
      ctx.arc(x, y, ring.r0 + (ring.r1 - ring.r0) * eased, ring.angle - ring.spread, ring.angle + ring.spread);
      ctx.strokeStyle = PALETTE[ring.color];
      ctx.globalAlpha = 1 - t;
      ctx.lineWidth = ring.width * (1 - t * 0.6);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const t of this.texts) {
      const x = wrapDelta(t.x - camX, WORLD_SIZE);
      const y = wrapDelta(t.y - camY, WORLD_SIZE);
      ctx.globalAlpha = Math.min(1, t.life * 2);
      ctx.font = `bold ${t.size}px ui-monospace, Menlo, Consolas, monospace`;
      ctx.fillStyle = t.color;
      ctx.fillText(t.label, x, y);
    }
    ctx.globalAlpha = 1;
  }
}
